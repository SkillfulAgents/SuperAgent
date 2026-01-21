import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { connectedAccounts } from '@/lib/db/schema'
import { getConnection } from '@/lib/composio/client'
import { getProvider } from '@/lib/composio/providers'

// GET /api/connected-accounts/callback - OAuth callback handler
// Composio redirects here after OAuth completes
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams

    // Composio sends 'connectedAccountId', not 'connectionId'
    const connectionId = searchParams.get('connectedAccountId')
    const status = searchParams.get('status')
    const toolkit = searchParams.get('toolkit')

    // Handle OAuth failure
    if (status === 'failed' || !connectionId) {
      const error = searchParams.get('error') || 'OAuth flow failed'
      return new NextResponse(
        generateCallbackHtml({ success: false, error }),
        { headers: { 'Content-Type': 'text/html' } }
      )
    }

    if (!toolkit) {
      return new NextResponse(
        generateCallbackHtml({ success: false, error: 'Missing toolkit parameter' }),
        { headers: { 'Content-Type': 'text/html' } }
      )
    }

    // Fetch connection details from Composio
    const connection = await getConnection(connectionId)

    if (connection.status !== 'ACTIVE') {
      return new NextResponse(
        generateCallbackHtml({
          success: false,
          error: `Connection status: ${connection.status}`,
        }),
        { headers: { 'Content-Type': 'text/html' } }
      )
    }

    // Get provider info for display name
    const toolkitSlug = toolkit.toLowerCase()
    const provider = getProvider(toolkitSlug)
    const displayName = provider?.displayName || toolkit

    // Save to our database
    const id = crypto.randomUUID()
    const now = new Date()

    await db.insert(connectedAccounts).values({
      id,
      composioConnectionId: connectionId,
      toolkitSlug,
      displayName,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })

    // Return HTML that posts message to parent window and closes
    return new NextResponse(
      generateCallbackHtml({
        success: true,
        accountId: id,
        displayName,
        toolkitSlug,
      }),
      { headers: { 'Content-Type': 'text/html' } }
    )
  } catch (error: any) {
    console.error('OAuth callback error:', error)

    // Handle duplicate connection
    if (error.message?.includes('UNIQUE constraint failed')) {
      return new NextResponse(
        generateCallbackHtml({
          success: false,
          error: 'This account is already connected',
        }),
        { headers: { 'Content-Type': 'text/html' } }
      )
    }

    return new NextResponse(
      generateCallbackHtml({
        success: false,
        error: error.message || 'Failed to complete OAuth',
      }),
      { headers: { 'Content-Type': 'text/html' } }
    )
  }
}

interface CallbackResult {
  success: boolean
  accountId?: string
  displayName?: string
  toolkitSlug?: string
  error?: string
}

function generateCallbackHtml(result: CallbackResult): string {
  const message = JSON.stringify({
    type: 'oauth-callback',
    ...result,
  })

  return `<!DOCTYPE html>
<html>
<head>
  <title>${result.success ? 'Connected!' : 'Connection Failed'}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: #f5f5f5;
    }
    .container {
      text-align: center;
      padding: 2rem;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .success { color: #16a34a; }
    .error { color: #dc2626; }
    .message { color: #666; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    ${
      result.success
        ? `<h2 class="success">Connected Successfully!</h2>
           <p class="message">You can close this window.</p>`
        : `<h2 class="error">Connection Failed</h2>
           <p class="message">${result.error || 'An error occurred'}</p>`
    }
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage(${message}, '*');
      setTimeout(() => window.close(), ${result.success ? 1000 : 3000});
    }
  </script>
</body>
</html>`
}

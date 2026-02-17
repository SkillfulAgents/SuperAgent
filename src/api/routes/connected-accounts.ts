import { Hono } from 'hono'
import { db } from '@shared/lib/db'
import { connectedAccounts } from '@shared/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { getProvider, isProviderSupported } from '@shared/lib/composio/providers'
import {
  getOrCreateAuthConfig,
  initiateConnection,
  getConnection,
  deleteConnection,
  getAccountDisplayName,
} from '@shared/lib/composio/client'

const connectedAccountsRouter = new Hono()

// GET /api/connected-accounts - List all app-level connected accounts
connectedAccountsRouter.get('/', async (c) => {
  try {
    const accounts = await db
      .select()
      .from(connectedAccounts)
      .orderBy(desc(connectedAccounts.createdAt))

    const enriched = accounts.map((account) => ({
      ...account,
      provider: getProvider(account.toolkitSlug),
    }))

    return c.json({ accounts: enriched })
  } catch (error) {
    console.error('Failed to fetch connected accounts:', error)
    return c.json({ error: 'Failed to fetch connected accounts' }, 500)
  }
})

// POST /api/connected-accounts - Create a new connected account record
connectedAccountsRouter.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { composioConnectionId, toolkitSlug, displayName } = body

    if (!composioConnectionId || !toolkitSlug || !displayName) {
      return c.json(
        {
          error:
            'Missing required fields: composioConnectionId, toolkitSlug, displayName',
        },
        400
      )
    }

    const id = crypto.randomUUID()
    const now = new Date()

    await db.insert(connectedAccounts).values({
      id,
      composioConnectionId,
      toolkitSlug,
      displayName,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })

    const [created] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, id))
      .limit(1)

    return c.json({
      account: { ...created, provider: getProvider(toolkitSlug) },
    })
  } catch (error: any) {
    console.error('Failed to create connected account:', error)

    if (error.message?.includes('UNIQUE constraint failed')) {
      return c.json({ error: 'This connection already exists' }, 409)
    }

    return c.json({ error: 'Failed to create connected account' }, 500)
  }
})

// POST /api/connected-accounts/initiate - Start OAuth flow
connectedAccountsRouter.post('/initiate', async (c) => {
  try {
    const body = await c.req.json()
    const { providerSlug, electron } = body

    if (!providerSlug) {
      return c.json({ error: 'Missing required field: providerSlug' }, 400)
    }

    if (!isProviderSupported(providerSlug)) {
      return c.json(
        { error: `Provider '${providerSlug}' is not supported` },
        400
      )
    }

    const authConfig = await getOrCreateAuthConfig(providerSlug)

    // Build the callback URL
    // For Electron, use custom protocol; for web, use HTTP callback
    let callbackUrl: string
    if (electron) {
      // Electron: use custom protocol that the app handles
      const protocol = process.env.SUPERAGENT_PROTOCOL || 'superagent'
      callbackUrl = `${protocol}://oauth-callback?toolkit=${encodeURIComponent(providerSlug)}`
    } else {
      // Web: use HTTP callback endpoint
      const origin = c.req.header('origin') || new URL(c.req.url).origin
      callbackUrl = `${origin}/api/connected-accounts/callback?toolkit=${encodeURIComponent(providerSlug)}`
    }

    const { connectionId, redirectUrl } = await initiateConnection(
      authConfig.id,
      callbackUrl
    )

    return c.json({
      connectionId,
      redirectUrl,
      providerSlug,
    })
  } catch (error: any) {
    console.error('Failed to initiate connection:', error)

    // Detect "no managed credentials" error from Composio and return a friendly message
    const slug = typeof error.details?.error === 'object' ? error.details.error.slug : undefined
    const isNoManagedAuth =
      slug === 'Auth_Config_DefaultAuthConfigNotFound' ||
      error.message?.includes('does not have managed credentials')

    if (isNoManagedAuth) {
      return c.json(
        {
          error: `This provider requires custom OAuth credentials. Composio does not have managed credentials for it. Please set up your own app credentials in the Composio dashboard and configure a custom auth config for this provider.`,
        },
        400
      )
    }

    return c.json(
      { error: error.message || 'Failed to initiate connection' },
      error.statusCode || 500
    )
  }
})

// POST /api/connected-accounts/complete - Complete OAuth flow (for Electron)
connectedAccountsRouter.post('/complete', async (c) => {
  try {
    const body = await c.req.json()
    const { connectionId, toolkit } = body

    if (!connectionId) {
      return c.json({ error: 'Missing connectionId' }, 400)
    }

    if (!toolkit) {
      return c.json({ error: 'Missing toolkit' }, 400)
    }

    const connection = await getConnection(connectionId)

    if (connection.status !== 'ACTIVE') {
      return c.json({ error: `Connection status: ${connection.status}` }, 400)
    }

    const toolkitSlug = toolkit.toLowerCase()
    const provider = getProvider(toolkitSlug)
    const fallbackName = provider?.displayName || toolkit

    // Try to get user-specific display name (e.g., email for Gmail)
    const displayName = await getAccountDisplayName(connectionId, toolkitSlug, fallbackName)

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

    return c.json({
      success: true,
      account: {
        id,
        composioConnectionId: connectionId,
        toolkitSlug,
        displayName,
        status: 'active',
      },
    })
  } catch (error: any) {
    console.error('OAuth complete error:', error)

    if (error.message?.includes('UNIQUE constraint failed')) {
      return c.json({ error: 'This account is already connected' }, 409)
    }

    return c.json({ error: error.message || 'Failed to complete OAuth' }, 500)
  }
})

// GET /api/connected-accounts/callback - OAuth callback handler (for web)
connectedAccountsRouter.get('/callback', async (c) => {
  try {
    const connectionId = c.req.query('connectedAccountId')
    const status = c.req.query('status')
    const toolkit = c.req.query('toolkit')

    if (status === 'failed' || !connectionId) {
      const error = c.req.query('error') || 'OAuth flow failed'
      return c.html(generateCallbackHtml({ success: false, error }))
    }

    if (!toolkit) {
      return c.html(
        generateCallbackHtml({ success: false, error: 'Missing toolkit parameter' })
      )
    }

    const connection = await getConnection(connectionId)

    if (connection.status !== 'ACTIVE') {
      return c.html(
        generateCallbackHtml({
          success: false,
          error: `Connection status: ${connection.status}`,
        })
      )
    }

    const toolkitSlug = toolkit.toLowerCase()
    const provider = getProvider(toolkitSlug)
    const fallbackName = provider?.displayName || toolkit

    // Try to get user-specific display name (e.g., email for Gmail)
    const displayName = await getAccountDisplayName(connectionId, toolkitSlug, fallbackName)

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

    return c.html(
      generateCallbackHtml({
        success: true,
        accountId: id,
        displayName,
        toolkitSlug,
      })
    )
  } catch (error: any) {
    console.error('OAuth callback error:', error)

    if (error.message?.includes('UNIQUE constraint failed')) {
      return c.html(
        generateCallbackHtml({
          success: false,
          error: 'This account is already connected',
        })
      )
    }

    return c.html(
      generateCallbackHtml({
        success: false,
        error: error.message || 'Failed to complete OAuth',
      })
    )
  }
})

// PATCH /api/connected-accounts/:id - Update a connected account (rename)
connectedAccountsRouter.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const { displayName } = body

    if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
      return c.json({ error: 'Missing or invalid displayName' }, 400)
    }

    const [existing] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, id))
      .limit(1)

    if (!existing) {
      return c.json({ error: 'Connected account not found' }, 404)
    }

    await db
      .update(connectedAccounts)
      .set({ displayName: displayName.trim(), updatedAt: new Date() })
      .where(eq(connectedAccounts.id, id))

    const [updated] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, id))
      .limit(1)

    return c.json({
      account: { ...updated, provider: getProvider(updated.toolkitSlug) },
    })
  } catch (error) {
    console.error('Failed to update connected account:', error)
    return c.json({ error: 'Failed to update connected account' }, 500)
  }
})

// DELETE /api/connected-accounts/:id - Delete a connected account
connectedAccountsRouter.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id')

    const [existing] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, id))
      .limit(1)

    if (!existing) {
      return c.json({ error: 'Connected account not found' }, 404)
    }

    try {
      await deleteConnection(existing.composioConnectionId)
    } catch (error) {
      console.warn('Failed to delete connection from Composio:', error)
    }

    await db.delete(connectedAccounts).where(eq(connectedAccounts.id, id))

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete connected account:', error)
    return c.json({ error: 'Failed to delete connected account' }, 500)
  }
})

interface CallbackResult {
  success: boolean
  accountId?: string
  displayName?: string
  toolkitSlug?: string
  error?: string
}

/**
 * Escape a string for safe inclusion in HTML content
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function generateCallbackHtml(result: CallbackResult): string {
  // Escape all user-provided content to prevent XSS
  const safeResult: CallbackResult = {
    success: result.success,
    accountId: result.accountId,
    displayName: result.displayName ? escapeHtml(result.displayName) : undefined,
    toolkitSlug: result.toolkitSlug ? escapeHtml(result.toolkitSlug) : undefined,
    error: result.error ? escapeHtml(result.error) : undefined,
  }

  // JSON.stringify and escape for safe embedding in script tag
  const message = JSON.stringify({
    type: 'oauth-callback',
    ...safeResult,
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')

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
           <p class="message">${safeResult.error || 'An error occurred'}</p>`
    }
  </div>
  <script>
    if (window.opener) {
      try {
        // Get the opener's origin for secure postMessage
        var targetOrigin = window.opener.location.origin;
        window.opener.postMessage(${message}, targetOrigin);
      } catch (e) {
        // Cross-origin - use fallback (opener will validate message type)
        window.opener.postMessage(${message}, '*');
      }
      setTimeout(function() { window.close(); }, ${result.success ? 1000 : 3000});
    }
  </script>
</body>
</html>`
}

export default connectedAccountsRouter

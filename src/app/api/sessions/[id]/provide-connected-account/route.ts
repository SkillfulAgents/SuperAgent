import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  sessions,
  connectedAccounts,
  agentConnectedAccounts,
} from '@/lib/db/schema'
import { eq, inArray } from 'drizzle-orm'
import { containerManager } from '@/lib/container/container-manager'
import { getConnectionToken } from '@/lib/composio/client'

interface ProvideConnectedAccountRequest {
  toolUseId: string // Used for container resolution
  toolkit: string // The toolkit slug (e.g., 'gmail')
  accountIds?: string[] // App-level account IDs to provide
  decline?: boolean
  declineReason?: string
}

// POST /api/sessions/[id]/provide-connected-account - Provide or decline a connected account request
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: sessionId } = await params
    const body: ProvideConnectedAccountRequest = await request.json()
    const { toolUseId, toolkit, accountIds, decline, declineReason } = body

    // Validate required fields
    if (!toolUseId) {
      return NextResponse.json(
        { error: 'toolUseId is required' },
        { status: 400 }
      )
    }

    if (!toolkit) {
      return NextResponse.json(
        { error: 'toolkit is required' },
        { status: 400 }
      )
    }

    // Get session to find agentId
    const [sessionData] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)

    if (!sessionData) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    const agentId = sessionData.agentId

    // Get container client and verify it's running
    const client = containerManager.getClient(agentId)
    const info = await client.getInfo()

    if (info.status !== 'running' || !info.port) {
      return NextResponse.json(
        { error: 'Agent container is not running' },
        { status: 503 }
      )
    }

    const containerPort = info.port

    // Handle decline
    if (decline) {
      const reason = declineReason || 'User declined to provide access'

      const rejectResponse = await fetch(
        `http://localhost:${containerPort}/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        const error = await rejectResponse.json()
        console.error('Failed to reject connected account request:', error)
        return NextResponse.json(
          { error: 'Failed to reject request' },
          { status: 500 }
        )
      }

      return NextResponse.json({ success: true, declined: true })
    }

    // Handle provide - accountIds is required
    if (!accountIds || accountIds.length === 0) {
      return NextResponse.json(
        { error: 'accountIds is required when not declining' },
        { status: 400 }
      )
    }

    // Get the selected accounts
    const accounts = await db
      .select()
      .from(connectedAccounts)
      .where(inArray(connectedAccounts.id, accountIds))

    if (accounts.length === 0) {
      return NextResponse.json(
        { error: 'No valid accounts found' },
        { status: 400 }
      )
    }

    // Filter to accounts matching the toolkit
    const validAccounts = accounts.filter((a) => a.toolkitSlug === toolkit)
    if (validAccounts.length === 0) {
      return NextResponse.json(
        { error: `No accounts found for toolkit '${toolkit}'` },
        { status: 400 }
      )
    }

    // Map accounts to agent (if not already mapped)
    const now = new Date()
    for (const account of validAccounts) {
      try {
        await db.insert(agentConnectedAccounts).values({
          id: crypto.randomUUID(),
          agentId,
          connectedAccountId: account.id,
          createdAt: now,
        })
      } catch {
        // Ignore duplicate mapping errors
      }
    }

    // Fetch tokens from Composio and build the env var value
    // Format: { "Display Name": "token1", "Other Account": "token2" }
    const tokens: Record<string, string> = {}
    for (const account of validAccounts) {
      try {
        const { accessToken } = await getConnectionToken(
          account.composioConnectionId
        )
        tokens[account.displayName] = accessToken
      } catch (error) {
        console.error(
          `Failed to get token for account ${account.displayName}:`,
          error
        )
        // Continue with other accounts
      }
    }

    if (Object.keys(tokens).length === 0) {
      return NextResponse.json(
        { error: 'Failed to fetch access tokens from Composio' },
        { status: 500 }
      )
    }

    // Set environment variable in container
    // Format: CONNECTED_ACCOUNT_GMAIL={"Work Gmail": "token1", "Personal": "token2"}
    const envVarName = `CONNECTED_ACCOUNT_${toolkit.toUpperCase()}`
    const envVarValue = JSON.stringify(tokens)

    console.log(
      `[provide-connected-account] Setting env var ${envVarName} in container`
    )
    const envResponse = await fetch(`http://localhost:${containerPort}/env`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: envVarName, value: envVarValue }),
    })

    if (!envResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await envResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await envResponse.text()
      }
      console.error(
        `[provide-connected-account] Failed to set env var: ${errorDetails}`
      )
      return NextResponse.json(
        { error: 'Failed to set environment variable in container' },
        { status: 500 }
      )
    }
    console.log(
      `[provide-connected-account] Env var ${envVarName} set successfully`
    )

    // Resolve the pending input request
    console.log(
      `[provide-connected-account] Resolving pending request ${toolUseId}`
    )
    const resolveResponse = await fetch(
      `http://localhost:${containerPort}/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: `Access granted to ${Object.keys(tokens).length} account(s): ${Object.keys(tokens).join(', ')}`,
        }),
      }
    )

    if (!resolveResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await resolveResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await resolveResponse.text()
      }
      console.error(
        `[provide-connected-account] Failed to resolve request: ${errorDetails}`
      )
      return NextResponse.json(
        { error: 'Accounts mapped but failed to notify agent' },
        { status: 500 }
      )
    }
    console.log(
      `[provide-connected-account] Request ${toolUseId} resolved successfully`
    )

    return NextResponse.json({
      success: true,
      accountsProvided: Object.keys(tokens).length,
    })
  } catch (error: any) {
    console.error('Failed to provide connected account:', error)
    return NextResponse.json(
      { error: 'Failed to provide connected account', details: error.message },
      { status: 500 }
    )
  }
}

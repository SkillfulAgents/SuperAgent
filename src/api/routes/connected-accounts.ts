import { Hono } from 'hono'
import { db } from '@shared/lib/db'
import { connectedAccounts, agentConnectedAccounts } from '@shared/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import {
  getProvider,
  isProviderSupported,
  getDefaultAccountProvider,
  getAccountProviderByName,
  isValidProviderName,
} from '@shared/lib/account-providers'
import { getAppBaseUrlFromRequest, getCurrentUserId } from '@shared/lib/auth/config'
import { isAuthMode } from '@shared/lib/auth/mode'
import { isOwnedByCaller } from '@shared/lib/auth/ownership'
import { getAccountProviderUserId } from '@shared/lib/config/settings'
import { Authenticated, OwnsAccount, IsAdmin, Or } from '../middleware/auth'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { countActiveTriggersPerAccount } from '@shared/lib/services/webhook-trigger-service'

const connectedAccountsRouter = new Hono()

connectedAccountsRouter.use('*', Authenticated())

// GET /api/connected-accounts - List connected accounts (scoped to user in auth mode)
connectedAccountsRouter.get('/', async (c) => {
  try {
    let query = db
      .select()
      .from(connectedAccounts)
      .orderBy(desc(connectedAccounts.createdAt))
      .$dynamic()

    if (isAuthMode()) {
      query = query.where(eq(connectedAccounts.userId, getCurrentUserId(c)))
    }

    const accounts = await query

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
    const { providerConnectionId, providerName, toolkitSlug, displayName, status: reqStatus } = body

    if (!providerConnectionId || !toolkitSlug || !displayName) {
      return c.json(
        {
          error:
            'Missing required fields: providerConnectionId, toolkitSlug, displayName',
        },
        400
      )
    }

    const id = crypto.randomUUID()
    const now = new Date()

    await db.insert(connectedAccounts).values({
      id,
      providerConnectionId,
      providerName: providerName ?? 'composio',
      toolkitSlug,
      displayName,
      userId: getCurrentUserId(c),
      status: reqStatus ?? 'active',
      createdAt: now,
      updatedAt: now,
    })

    const [created] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, id))
      .limit(1)

    logAuditEvent({ userId: getCurrentUserId(c), object: 'account', objectId: id, action: 'connected', details: { toolkitSlug, displayName } })

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

// POST /api/connected-accounts/sync - Trigger account status sync with remote providers
connectedAccountsRouter.post('/sync', async (c) => {
  try {
    const { accountSyncService } = await import('@shared/lib/scheduler/account-sync-service')
    await accountSyncService.syncAll()
    return c.json({ success: true })
  } catch (error: any) {
    console.error('Account sync failed:', error)
    return c.json({ error: error.message || 'Sync failed' }, 500)
  }
})

// POST /api/connected-accounts/initiate - Start OAuth flow
connectedAccountsRouter.post('/initiate', async (c) => {
  try {
    const body = await c.req.json()
    const { providerSlug, electron, reconnectAccountId } = body

    if (!providerSlug) {
      return c.json({ error: 'Missing required field: providerSlug' }, 400)
    }

    // If reconnecting, verify the account exists and belongs to this user.
    // In auth mode, scope ownership to the acting user so a user cannot take
    // over another user's connected account by guessing its id (SUP-198).
    if (reconnectAccountId) {
      const [existing] = await db
        .select()
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, reconnectAccountId))
        .limit(1)
      if (!existing || !isOwnedByCaller(c, existing)) {
        return c.json({ error: 'Account not found' }, 404)
      }
    }

    const provider = getDefaultAccountProvider()

    if (!isProviderSupported(providerSlug, provider.name)) {
      return c.json(
        { error: `Provider '${providerSlug}' is not supported by ${provider.name}` },
        400
      )
    }

    // Build the callback URL
    // For Electron, use custom protocol; for web, use HTTP callback
    const reconnectParam = reconnectAccountId ? `&reconnectAccountId=${encodeURIComponent(reconnectAccountId)}` : ''
    let callbackUrl: string
    if (electron) {
      const protocol = process.env.SUPERAGENT_PROTOCOL || 'superagent'
      callbackUrl = `${protocol}://oauth-callback?toolkit=${encodeURIComponent(providerSlug)}&providerName=${encodeURIComponent(provider.name)}${reconnectParam}`
    } else {
      const origin = getAppBaseUrlFromRequest(c)
      callbackUrl = `${origin}/api/connected-accounts/callback?toolkit=${encodeURIComponent(providerSlug)}&providerName=${encodeURIComponent(provider.name)}${reconnectParam}`
    }

    const userId = isAuthMode()
      ? getCurrentUserId(c)
      : getAccountProviderUserId()

    const { connectionId, redirectUrl } = await provider.initiateConnection(
      providerSlug,
      callbackUrl,
      userId
    )

    return c.json({
      connectionId,
      redirectUrl,
      providerSlug,
      providerName: provider.name,
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
          error: `This provider requires custom OAuth credentials. The account provider does not have managed credentials for it.`,
        },
        400
      )
    }

    // Never forward upstream 401s as our own — 401 is reserved for session auth
    // and triggers auto-sign-out on the frontend. Use 424 (Failed Dependency)
    // so reverse proxies like Cloudflare don't intercept the response.
    const status = error.statusCode === 401 ? 424 : (error.statusCode || 500)
    return c.json(
      { error: error.message || 'Failed to initiate connection' },
      status
    )
  }
})

// POST /api/connected-accounts/complete - Complete OAuth flow (for Electron)
connectedAccountsRouter.post('/complete', async (c) => {
  try {
    const body = await c.req.json()
    const { connectionId, toolkit, providerName: reqProviderName, reconnectAccountId } = body

    if (!connectionId) {
      return c.json({ error: 'Missing connectionId' }, 400)
    }

    if (!toolkit) {
      return c.json({ error: 'Missing toolkit' }, 400)
    }

    const providerName = reqProviderName ?? 'composio'
    if (!isValidProviderName(providerName)) {
      return c.json({ error: `Unknown account provider: "${providerName}"` }, 400)
    }
    const accountProvider = getAccountProviderByName(providerName)
    const toolkitSlug = toolkit.toLowerCase()

    const connection = await accountProvider.getConnection(connectionId, toolkitSlug)

    if (connection.status !== 'ACTIVE') {
      return c.json({ error: `Connection status: ${connection.status}` }, 400)
    }
    const serviceProvider = getProvider(toolkitSlug)
    const fallbackName = serviceProvider?.displayName || toolkit

    const displayName = await accountProvider.getAccountDisplayName(connectionId, toolkitSlug, fallbackName)

    const now = new Date()
    let id: string

    if (reconnectAccountId) {
      // Look up old connection ID (and owner) before updating so we can clean it
      // up remotely and verify ownership.
      const [oldRecord] = await db
        .select({
          providerConnectionId: connectedAccounts.providerConnectionId,
          userId: connectedAccounts.userId,
        })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, reconnectAccountId))
        .limit(1)

      // The account must exist and, in auth mode, be owned by the acting user.
      // Otherwise a user could overwrite another user's connection (SUP-198).
      if (!oldRecord || !isOwnedByCaller(c, oldRecord)) {
        return c.json({ error: 'Account not found' }, 404)
      }

      // Reconnecting: update existing record to preserve agent mappings and scope policies
      await db.update(connectedAccounts)
        .set({
          providerConnectionId: connectionId,
          providerName,
          displayName,
          status: 'active',
          updatedAt: now,
        })
        .where(eq(connectedAccounts.id, reconnectAccountId))
      id = reconnectAccountId

      // Clean up the old remote connection (fire-and-forget)
      if (oldRecord && oldRecord.providerConnectionId !== connectionId) {
        accountProvider.deleteConnection(oldRecord.providerConnectionId, toolkitSlug)
          .catch((err) => console.warn('[reconnect] Failed to delete old remote connection:', err))
      }

      trackServerEvent('account_oauth_reconnected', { toolkitSlug })
      logAuditEvent({ userId: getCurrentUserId(c), object: 'account', objectId: id, action: 'connected', details: { toolkitSlug } })
    } else {
      id = crypto.randomUUID()

      await db.insert(connectedAccounts).values({
        id,
        providerConnectionId: connectionId,
        providerName,
        toolkitSlug,
        displayName,
        userId: getCurrentUserId(c),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })

      trackServerEvent('account_oauth_succeeded', { toolkitSlug })
      logAuditEvent({ userId: getCurrentUserId(c), object: 'account', objectId: id, action: 'connected', details: { toolkitSlug } })
    }

    return c.json({
      success: true,
      account: {
        id,
        providerConnectionId: connectionId,
        providerName,
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
    // Provider callback may use either casing — accept both.
    const connectionId =
      c.req.query('connectedAccountId') || c.req.query('connected_account_id')
    const status = c.req.query('status')
    const toolkit = c.req.query('toolkit')
    const providerName = c.req.query('providerName') ?? 'composio'
    const reconnectAccountId = c.req.query('reconnectAccountId')

    if (!isValidProviderName(providerName)) {
      return c.html(
        generateCallbackHtml({ success: false, error: `Unknown account provider: "${providerName}"` })
      )
    }

    if (status === 'failed' || !connectionId) {
      const error = c.req.query('error') || 'OAuth flow failed'
      return c.html(generateCallbackHtml({ success: false, error }))
    }

    if (!toolkit) {
      return c.html(
        generateCallbackHtml({ success: false, error: 'Missing toolkit parameter' })
      )
    }

    const accountProvider = getAccountProviderByName(providerName)
    const toolkitSlug = toolkit.toLowerCase()
    const connection = await accountProvider.getConnection(connectionId, toolkitSlug)

    if (connection.status !== 'ACTIVE') {
      return c.html(
        generateCallbackHtml({
          success: false,
          error: `Connection status: ${connection.status}`,
        })
      )
    }
    const serviceProvider = getProvider(toolkitSlug)
    const fallbackName = serviceProvider?.displayName || toolkit

    const displayName = await accountProvider.getAccountDisplayName(connectionId, toolkitSlug, fallbackName)

    const now = new Date()
    let id: string

    if (reconnectAccountId) {
      const [oldRecord] = await db
        .select({
          providerConnectionId: connectedAccounts.providerConnectionId,
          userId: connectedAccounts.userId,
        })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, reconnectAccountId))
        .limit(1)

      // The account must exist and, in auth mode, be owned by the acting user.
      // Otherwise a user could overwrite another user's connection (SUP-198).
      if (!oldRecord || !isOwnedByCaller(c, oldRecord)) {
        return c.html(
          generateCallbackHtml({ success: false, error: 'Account not found' })
        )
      }

      await db.update(connectedAccounts)
        .set({
          providerConnectionId: connectionId,
          providerName,
          displayName,
          status: 'active',
          updatedAt: now,
        })
        .where(eq(connectedAccounts.id, reconnectAccountId))
      id = reconnectAccountId

      if (oldRecord && oldRecord.providerConnectionId !== connectionId) {
        accountProvider.deleteConnection(oldRecord.providerConnectionId, toolkitSlug)
          .catch((err) => console.warn('[reconnect] Failed to delete old remote connection:', err))
      }

      trackServerEvent('account_oauth_reconnected', { toolkitSlug })
      logAuditEvent({ userId: getCurrentUserId(c), object: 'account', objectId: id, action: 'connected', details: { toolkitSlug } })
    } else {
      id = crypto.randomUUID()

      await db.insert(connectedAccounts).values({
        id,
        providerConnectionId: connectionId,
        providerName,
        toolkitSlug,
        displayName,
        userId: getCurrentUserId(c),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })

      trackServerEvent('account_oauth_succeeded', { toolkitSlug })
      logAuditEvent({ userId: getCurrentUserId(c), object: 'account', objectId: id, action: 'connected', details: { toolkitSlug } })
    }

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

// GET /api/connected-accounts/trigger-counts - active webhook trigger counts per account
connectedAccountsRouter.get('/trigger-counts', async (c) => {
  try {
    // Scope to current user's accounts to prevent cross-user data leakage
    let userAccountIds: string[] | undefined
    if (isAuthMode()) {
      const userId = getCurrentUserId(c)
      const userAccounts = await db
        .select({ id: connectedAccounts.id })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.userId, userId))
      userAccountIds = userAccounts.map((a) => a.id)
      if (userAccountIds.length === 0) {
        return c.json({})
      }
    }

    const counts = await countActiveTriggersPerAccount(userAccountIds)
    return c.json(counts)
  } catch (error) {
    console.error('Failed to fetch trigger counts:', error)
    return c.json({}, 200) // gracefully return empty on error
  }
})

// GET /api/connected-accounts/:id/agents - List agent slugs that have this account mapped
connectedAccountsRouter.get('/:id/agents', Or(OwnsAccount(), IsAdmin()), async (c) => {
  try {
    const id = c.req.param('id')
    const mappings = await db
      .select({ agentSlug: agentConnectedAccounts.agentSlug })
      .from(agentConnectedAccounts)
      .where(eq(agentConnectedAccounts.connectedAccountId, id))
    return c.json({ agentSlugs: mappings.map((m) => m.agentSlug) })
  } catch (error) {
    console.error('Failed to list agents for connected account:', error)
    return c.json({ error: 'Failed to list agents' }, 500)
  }
})

// PATCH /api/connected-accounts/:id - Update a connected account (rename)
connectedAccountsRouter.patch('/:id', Or(OwnsAccount(), IsAdmin()), async (c) => {
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
connectedAccountsRouter.delete('/:id', Or(OwnsAccount(), IsAdmin()), async (c) => {
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
      const accountProvider = getAccountProviderByName(existing.providerName)
      await accountProvider.deleteConnection(existing.providerConnectionId, existing.toolkitSlug)
    } catch (error) {
      console.warn('Failed to delete connection from provider:', error)
    }

    await db.delete(connectedAccounts).where(eq(connectedAccounts.id, id))

    logAuditEvent({ userId: getCurrentUserId(c), object: 'account', objectId: id, action: 'disconnected', details: { toolkitSlug: existing.toolkitSlug } })

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
      window.opener.postMessage(${message}, window.location.origin);
      setTimeout(function() { window.close(); }, ${result.success ? 1000 : 3000});
    }
  </script>
</body>
</html>`
}

export default connectedAccountsRouter

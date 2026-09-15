import { Hono, type Context } from 'hono'
import { db } from '@shared/lib/db'
import { connectedAccounts, agentConnectedAccounts } from '@shared/lib/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import {
  getProvider,
  isProviderSupported,
  getDefaultAccountProvider,
  getAccountProviderByName,
  isValidProviderName,
} from '@shared/lib/account-providers'
import { getAppBaseUrlFromRequest, getCurrentUserId } from '@shared/lib/auth/config'
import { isAuthMode } from '@shared/lib/auth/mode'
import { isOwnedByCaller, ownerScope } from '@shared/lib/auth/ownership'
import { getAccountProviderUserId } from '@shared/lib/config/settings'
import { Authenticated, OwnsAccount, IsAdmin, Or } from '../middleware/auth'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { countActiveTriggersPerAccount, cancelTriggersForConnectedAccount } from '@shared/lib/services/webhook-trigger-service'
import {
  findAgentsAssignedConnectedAccount,
  syncAgentsAssignedConnectedAccount,
  syncConnectedAccountAgents,
} from '@shared/lib/services/connection-sync-service'
import { accountReauthManager } from '@shared/lib/proxy/account-reauth-manager'
import { parseShopDomain } from '@shared/lib/account-providers/shopify'

const connectedAccountsRouter = new Hono()

const SHOPIFY_STORE_UNVERIFIED = "Couldn't confirm which Shopify store was connected. Try connecting again."

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

    if (toolkitSlug === 'shopify' && !parseShopDomain(displayName)) {
      // The store is the account's identity: the connect path finds the row for
      // a store by this name, so a row named anything else would be duplicated.
      return c.json({ error: 'A Shopify account is named after its store' }, 400)
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

/**
 * The caller's account for a Shopify store. Shopify keeps one refresh token per
 * app and store, so a second Composio grant would break that account's
 * connection: every connect for the store reuses it.
 */
async function findStoreAccount(c: Context, store: string) {
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(and(
      eq(connectedAccounts.toolkitSlug, 'shopify'),
      eq(connectedAccounts.displayName, store),
      ownerScope(c, connectedAccounts.userId),
    ))
    .limit(1)
  return account
}

/**
 * Where a finished Shopify grant is saved. The store Composio authorized is the
 * account's identity, so an unverified store is refused and the account for that
 * store is the one updated, whichever account the reconnect started from. A
 * merchant who authorizes a different store than the one they set out to
 * reconnect gets that store's account updated instead of a dead end.
 */
async function resolveShopifyTarget(
  c: Context,
  toolkitSlug: string,
  displayName: string,
  reconnectAccountId: string | undefined,
): Promise<{ error: string } | { reconnectAccountId: string | undefined }> {
  if (toolkitSlug !== 'shopify') return { reconnectAccountId }
  if (!parseShopDomain(displayName)) return { error: SHOPIFY_STORE_UNVERIFIED }
  return { reconnectAccountId: (await findStoreAccount(c, displayName))?.id }
}

/**
 * The account a finished grant replaces. It must be the caller's account for
 * the same toolkit.
 */
async function findReconnectTarget(c: Context, accountId: string, toolkitSlug: string) {
  const [account] = await db
    .select({
      providerConnectionId: connectedAccounts.providerConnectionId,
      userId: connectedAccounts.userId,
      toolkitSlug: connectedAccounts.toolkitSlug,
    })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, accountId))
    .limit(1)
  // In auth mode a user could otherwise overwrite another user's connection (SUP-198).
  if (!account || !isOwnedByCaller(c, account) || account.toolkitSlug !== toolkitSlug) {
    return { error: 'Account not found', status: 404 as const }
  }
  return { account }
}

// POST /api/connected-accounts/initiate - Start OAuth flow
connectedAccountsRouter.post('/initiate', async (c) => {
  try {
    const body = await c.req.json()
    const { providerSlug, electron } = body
    let { reconnectAccountId } = body
    let shop = parseShopDomain(body.shop)

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
      if (!existing || !isOwnedByCaller(c, existing) || existing.toolkitSlug !== providerSlug) {
        return c.json({ error: 'Account not found' }, 404)
      }
      // A Shopify account is named after its store, so a reconnect goes
      // straight back through Composio for that already-installed store.
      if (providerSlug === 'shopify') shop = parseShopDomain(existing.displayName)
    }

    const provider = getDefaultAccountProvider()

    if (!isProviderSupported(providerSlug, provider.name)) {
      return c.json(
        { error: `Provider '${providerSlug}' is not supported by ${provider.name}` },
        400
      )
    }

    // Shopify installs come from the App Store listing, which the renderer opens
    // itself: a connect with no store never reaches Composio.
    if (providerSlug === 'shopify' && !shop) {
      return c.json({ error: 'Install Gamut from the Shopify App Store to connect a store' }, 400)
    }

    // One account per store: an active one is kept, a lapsed one is reconnected in
    // place. `shop` is set by the guard above; repeating it narrows the type.
    if (providerSlug === 'shopify' && shop && !reconnectAccountId) {
      const existing = await findStoreAccount(c, shop)
      if (existing?.status === 'active') {
        return c.json({ error: `${shop} is already connected` }, 409)
      }
      if (existing) reconnectAccountId = existing.id
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

    // The store is pre-filled so Composio sends the merchant straight to Shopify,
    // which approves an installed app without a prompt.
    const { connectionId, redirectUrl } = await provider.initiateConnection(
      providerSlug,
      callbackUrl,
      userId,
      shop?.replace(/\.myshopify\.com$/, ''),
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
    const { connectionId, toolkit, providerName: reqProviderName } = body
    let { reconnectAccountId } = body

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
    const shopifyTarget = await resolveShopifyTarget(c, toolkitSlug, displayName, reconnectAccountId)
    if ('error' in shopifyTarget) return c.json({ error: shopifyTarget.error }, 502)
    reconnectAccountId = shopifyTarget.reconnectAccountId

    const now = new Date()
    let id: string

    if (reconnectAccountId) {
      // Look up the old connection before updating so we can clean it up remotely.
      const target = await findReconnectTarget(c, reconnectAccountId, toolkitSlug)
      if (!('account' in target)) {
        return c.json({ error: target.error }, target.status)
      }
      const oldRecord = target.account

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

      // The account row now points at a provider connection that was verified
      // ACTIVE above. Resume every proxy request parked on this account before
      // the best-effort runtime refresh, which is unrelated to proxy tokens.
      accountReauthManager.completeAccount(id)

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

    const liveRefresh = await syncAgentsAssignedConnectedAccount(id)

    return c.json({
      success: true,
      liveRefresh,
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
    let reconnectAccountId = c.req.query('reconnectAccountId')

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
    const shopifyTarget = await resolveShopifyTarget(c, toolkitSlug, displayName, reconnectAccountId)
    if ('error' in shopifyTarget) {
      return c.html(generateCallbackHtml({ success: false, error: shopifyTarget.error }))
    }
    reconnectAccountId = shopifyTarget.reconnectAccountId

    const now = new Date()
    let id: string

    if (reconnectAccountId) {
      const target = await findReconnectTarget(c, reconnectAccountId, toolkitSlug)
      if (!('account' in target)) {
        return c.html(generateCallbackHtml({ success: false, error: target.error }))
      }
      const oldRecord = target.account

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

      accountReauthManager.completeAccount(id)

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

    // This HTML callback has no renderer response channel for a refresh
    // warning. The sync remains best-effort and logs failures server-side.
    await syncAgentsAssignedConnectedAccount(id)

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
    if (existing.toolkitSlug === 'shopify') {
      return c.json({ error: 'A Shopify connection is named after its store and cannot be renamed' }, 400)
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

    const liveRefresh = await syncAgentsAssignedConnectedAccount(id)
    return c.json({
      account: { ...updated, provider: getProvider(updated.toolkitSlug) },
      liveRefresh,
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

    // Cancel any webhook triggers bound to this account FIRST, while the account
    // and its auth are still present, so the upstream Composio subscription is
    // torn down too. Otherwise the trigger rows (no DB-level FK/cascade) would be
    // orphaned status='active' and keep feeding the live subscription (SUP-221).
    await cancelTriggersForConnectedAccount(id)

    try {
      const accountProvider = getAccountProviderByName(existing.providerName)
      await accountProvider.deleteConnection(existing.providerConnectionId, existing.toolkitSlug)
    } catch (error) {
      console.warn('Failed to delete connection from provider:', error)
    }

    let assignedAgentSlugs: string[] | null = null
    try {
      assignedAgentSlugs = await findAgentsAssignedConnectedAccount(id)
    } catch (error) {
      console.warn(`Failed to resolve agents assigned account ${id} before delete:`, error)
    }
    await db.delete(connectedAccounts).where(eq(connectedAccounts.id, id))
    const liveRefresh = assignedAgentSlugs
      ? await syncConnectedAccountAgents(assignedAgentSlugs)
      : false

    logAuditEvent({ userId: getCurrentUserId(c), object: 'account', objectId: id, action: 'disconnected', details: { toolkitSlug: existing.toolkitSlug } })

    return c.json({ success: true, liveRefresh })
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

  const returnTo = result.success && result.accountId
    ? `/settings/connections?detail=account-${encodeURIComponent(result.accountId)}`
    : null
  // For the script's textContent, which must not carry the HTML-escaped name.
  const rawDisplayName = JSON.stringify(result.displayName ?? '').replace(/</g, '\\u003c')

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
    } else if (${JSON.stringify(returnTo)}) {
      // Reached in this tab (a Shopify install connects without a popup): back to the account.
      var name = ${rawDisplayName};
      document.querySelector('.message').textContent =
        (name ? 'Connected ' + name + '. ' : '') + 'Opening your account…';
      window.location.replace(${JSON.stringify(returnTo)});
    }
  </script>
</body>
</html>`
}

export default connectedAccountsRouter

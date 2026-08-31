import { Hono } from 'hono'
import crypto from 'crypto'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { isHostAllowed } from '@shared/lib/proxy/allowed-hosts'
import { matchScopes } from '@shared/lib/proxy/scope-matcher'
import { resolveApiPolicy } from '@shared/lib/proxy/policy-resolver'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import { accountReauthManager } from '@shared/lib/proxy/account-reauth-manager'
import { isReauthDismissed, reauthDismissalReason, withDismissalReason } from '@shared/lib/proxy/reauth-dismissal'
import { getAccountProviderByName } from '@shared/lib/account-providers'
import { attribution, runWithAttribution } from '@shared/lib/platform-attribution'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { db } from '@shared/lib/db'
import {
  connectedAccounts,
  agentConnectedAccounts,
  proxyAuditLog,
} from '@shared/lib/db/schema'
import { eq, and } from 'drizzle-orm'

interface ProxyAuditEntry {
  agentSlug: string
  accountId: string
  toolkit: string
  targetHost: string
  targetPath: string
  method: string
  statusCode?: number
  errorMessage?: string
  policyDecision?: string
  matchedScopes?: string
}

async function writeProxyAuditEntry(entry: ProxyAuditEntry & { durationMs?: number }): Promise<void> {
  try {
    await db.insert(proxyAuditLog).values({
      id: crypto.randomUUID(),
      ...entry,
      statusCode: entry.statusCode ?? null,
      errorMessage: entry.errorMessage ?? null,
      durationMs: entry.durationMs ?? null,
      policyDecision: entry.policyDecision ?? null,
      matchedScopes: entry.matchedScopes ?? null,
      createdAt: new Date(),
    })
    trackServerEvent('api_called', { slug: entry.toolkit })
  } catch (error) {
    console.error('[proxy] Failed to write audit log:', error)
  }
}

const proxy = new Hono()

proxy.all('/:agentSlug/:accountId/:rest{.+}', async (c) => {
  const startTime = Date.now()
  const agentSlug = c.req.param('agentSlug')
  const accountId = c.req.param('accountId')
  const rest = c.req.param('rest') || ''

  // Stamp elapsed time (request entry → now) onto every audit entry. Every exit
  // path logs through this, so the API Logs Duration column is always populated.
  const logAuditEntry = (entry: ProxyAuditEntry) =>
    writeProxyAuditEntry({ ...entry, durationMs: Date.now() - startTime })

  // Parse target host and path from rest: <host>/<path...>
  const firstSlash = rest.indexOf('/')
  const targetHost = firstSlash === -1 ? rest : rest.slice(0, firstSlash)
  const targetPath = firstSlash === -1 ? '' : rest.slice(firstSlash + 1)

  const method = c.req.method

  if (!targetHost) {
    return c.json({ error: 'Missing target host in proxy URL' }, 400)
  }

  // 1. Validate synthetic token
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: '',
      targetHost,
      targetPath,
      method: c.req.method,
      errorMessage: 'Missing or invalid Authorization header',
    })
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  const synthToken = authHeader.slice(7)
  const validatedAgent = await validateProxyToken(synthToken)
  if (!validatedAgent) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: '',
      targetHost,
      targetPath,
      method: c.req.method,
      errorMessage: 'Invalid proxy token',
    })
    return c.json({ error: 'Invalid proxy token' }, 401)
  }

  if (validatedAgent !== agentSlug) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: '',
      targetHost,
      targetPath,
      method: c.req.method,
      errorMessage: 'Token does not match agent',
    })
    return c.json({ error: 'Token does not match agent' }, 403)
  }

  // 2. Look up connected account and verify it belongs to this agent
  const loadMappedAccount = async () => {
    const [result] = await db
      .select({ account: connectedAccounts })
      .from(agentConnectedAccounts)
      .innerJoin(
        connectedAccounts,
        eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id)
      )
      .where(
        and(
          eq(agentConnectedAccounts.agentSlug, agentSlug),
          eq(connectedAccounts.id, accountId)
        )
      )
      .limit(1)
    return result?.account ?? null
  }

  let account = await loadMappedAccount()
  if (!account) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: '',
      targetHost,
      targetPath,
      method: c.req.method,
      errorMessage: 'Account not found or not mapped to agent',
    })
    return c.json({ error: 'Account not found or not mapped to this agent' }, 404)
  }

  type ReauthResult =
    | { ok: true }
    // `dismissReason` is what the dismisser typed, forwarded so the agent
    // learns WHY a person cut its call off, not merely that they did.
    | { ok: false; reason: 'timeout' | 'dismissed' | 'missing' | 'inactive'; dismissReason?: string }

  const holdForReauth = async (status: 'expired' | 'revoked'): Promise<ReauthResult> => {
    try {
      await accountReauthManager.requestReauth({
        agentSlug,
        accountId,
        toolkit: account!.toolkitSlug,
        accountStatus: status,
      }, c.req.raw.signal)
    } catch (error) {
      // A person pressing Dismiss and a five-minute timer both land here; only
      // the first should read as a decision the agent must respect.
      if (isReauthDismissed(error)) {
        return { ok: false, reason: 'dismissed', dismissReason: reauthDismissalReason(error) }
      }
      return { ok: false, reason: 'timeout' }
    }

    const refreshed = await loadMappedAccount()
    if (!refreshed) return { ok: false, reason: 'missing' }
    if (refreshed.status !== 'active') return { ok: false, reason: 'inactive' }
    account = refreshed
    return { ok: true }
  }

  const reauthFailureResponse = async (
    result: Exclude<ReauthResult, { ok: true }>,
    status: 'expired' | 'revoked',
    auditError: (message: string, statusCode: number) => Promise<void>,
  ) => {
    if (result.reason === 'timeout') {
      await auditError(`Account re-authentication timed out (${status})`, 408)
      return c.json({
        error: 'account_reauth_timeout',
        message: 'The request timed out while waiting for the account to be reconnected.',
        accountStatus: status,
      }, 408)
    }

    if (result.reason === 'dismissed') {
      const message = withDismissalReason(
        'A user dismissed the reconnection request, so this call was not made. '
        + 'Do not retry it until the connection is reconnected.',
        result.dismissReason,
      )
      await auditError(`Account re-authentication dismissed by a user (${status})`, 403)
      return c.json({ error: 'account_reauth_dismissed', message, accountStatus: status }, 403)
    }

    const message = result.reason === 'missing'
      ? 'Connected account disappeared while re-authenticating.'
      : 'Connected account did not become active after re-authentication.'
    await auditError(message, result.reason === 'missing' ? 404 : 502)
    return c.json({ error: 'account_reauth_failed', message, accountStatus: status },
      result.reason === 'missing' ? 404 : 502)
  }

  // 3. Validate target host against toolkit allowlist
  if (!isHostAllowed(account.toolkitSlug, targetHost)) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: account.toolkitSlug,
      targetHost,
      targetPath,
      method: c.req.method,
      errorMessage: `Host '${targetHost}' not allowed for toolkit '${account.toolkitSlug}'`,
    })
    return c.json(
      {
        error: `Host '${targetHost}' is not allowed for toolkit '${account.toolkitSlug}'`,
      },
      403
    )
  }

  // 3.5 Policy enforcement
  let policyResult
  try {
    const matchResult = matchScopes(account.toolkitSlug, method, '/' + targetPath)
    const userId = account.userId ?? 'local'
    policyResult = await resolveApiPolicy(accountId, matchResult, userId, account.toolkitSlug)
  } catch (policyError) {
    console.error('[proxy] Policy enforcement failed, defaulting to review:', policyError)
    policyResult = { decision: 'review' as const, matchedScopes: [] as string[], scopeDescriptions: {} as Record<string, string>, resolvedFrom: 'global_default' as const }
  }

  if (policyResult.decision === 'block') {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: account.toolkitSlug,
      targetHost,
      targetPath,
      method,
      policyDecision: 'block',
      matchedScopes: JSON.stringify(policyResult.matchedScopes),
    })
    return c.json({
      error: 'blocked_by_policy',
      message: 'This request was blocked by your API access policy.',
      scopes: policyResult.matchedScopes,
      toolkit: account.toolkitSlug,
      settingsHint: 'You can adjust policies in Settings > Accounts > Policies',
    }, 403)
  }

  // Track the precise outcome for audit logging
  let resolvedPolicyDecision: string = policyResult.decision // 'allow' or 'review'

  if (policyResult.decision === 'review') {
    try {
      const decision = await reviewManager.requestReview({
        agentSlug,
        accountId,
        toolkit: account.toolkitSlug,
        method,
        targetPath,
        matchedScopes: policyResult.matchedScopes,
        scopeDescriptions: policyResult.scopeDescriptions,
        endpointDescription: policyResult.endpointDescription,
      }, c.req.raw.signal)
      if (decision === 'deny') {
        await logAuditEntry({
          agentSlug,
          accountId,
          toolkit: account.toolkitSlug,
          targetHost,
          targetPath,
          method,
          policyDecision: 'denied_by_user',
          matchedScopes: JSON.stringify(policyResult.matchedScopes),
        })
        return c.json({ error: 'denied_by_user', message: 'Request denied by user.' }, 403)
      }
      resolvedPolicyDecision = 'approved_by_user'
    } catch {
      await logAuditEntry({
        agentSlug,
        accountId,
        toolkit: account.toolkitSlug,
        targetHost,
        targetPath,
        method,
        policyDecision: 'review_timeout',
        matchedScopes: JSON.stringify(policyResult.matchedScopes),
      })
      return c.json({ error: 'review_timeout', message: 'Request required user approval but timed out.' }, 408)
    }
  }

  // resolvedPolicyDecision is now 'allow' (auto) or 'approved_by_user' (manual)

  // Audit helper: curried with all the context fields shared by every
  // post-policy audit entry. Caller supplies only what varies (statusCode,
  // errorMessage). Keeps the forward branches focused on the actual logic.
  const audit = (extras: {
    statusCode?: number
    errorMessage?: string
  }) =>
    logAuditEntry({
      agentSlug,
      accountId,
      toolkit: account.toolkitSlug,
      targetHost,
      targetPath,
      method,
      policyDecision: resolvedPolicyDecision,
      matchedScopes: JSON.stringify(policyResult.matchedScopes),
      ...extras,
    })

  // Park only after the request has passed both the host allowlist and API
  // policy gate. Re-authentication cannot turn a forbidden request into an
  // allowed one, so prompting before these checks only interrupts the user
  // for work that will be rejected immediately afterward.
  if (account.status !== 'active') {
    const status = account.status
    const result = await holdForReauth(status)
    if (!result.ok) {
      return reauthFailureResponse(result, status, (errorMessage, statusCode) =>
        audit({ statusCode, errorMessage }))
    }
  }

  // 4. Build target URL
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const queryString = new URL(c.req.url).search
  const targetUrl = `https://${targetHost}/${targetPath}${queryString}`

  // 5. Verify remote connection status before forwarding
  let provider = getAccountProviderByName(account.providerName)

  let remoteConnection: Awaited<ReturnType<typeof provider.getConnection>> | null = null
  try {
    remoteConnection = await provider.getConnection(
      account.providerConnectionId,
      account.toolkitSlug,
    )
  } catch (statusCheckErr) {
    console.warn('[proxy] Remote status check failed, proceeding with request:', statusCheckErr)
  }

  if (remoteConnection && remoteConnection.status !== 'ACTIVE') {
    const newStatus = remoteConnection.status === 'EXPIRED' ? 'expired' as const : 'revoked' as const
    try {
      await db.update(connectedAccounts)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(eq(connectedAccounts.id, accountId))
    } catch (statusUpdateErr) {
      console.warn('[proxy] Failed to persist non-active account status:', statusUpdateErr)
    }

    const reauthResult = await holdForReauth(newStatus)
    if (!reauthResult.ok) {
      return reauthFailureResponse(reauthResult, newStatus, (errorMessage, statusCode) =>
        audit({ statusCode, errorMessage }))
    }
    provider = getAccountProviderByName(account.providerName)
  }

  // 6. Forward via account provider (handles token retrieval/proxy internally)
  const requestBody = (method === 'GET' || method === 'HEAD')
    ? null
    : await c.req.arrayBuffer()

  const forwardRequest = () => runWithAttribution(
      attribution.fromResourceCreator(account.userId),
      () => provider.makeApiCall({
        providerConnectionId: account.providerConnectionId,
        toolkitSlug: account.toolkitSlug,
        targetUrl,
        method,
        headers: c.req.raw.headers,
        body: requestBody,
      }),
    )

  let response: Response
  try {
    response = await forwardRequest()
  } catch (error) {
    const isTokenError = String(error).includes('token') || String(error).includes('Token')
    const errorLabel = isTokenError ? 'Failed to fetch access token' : 'Proxy request failed'

    if (isTokenError) {
      try {
        await db.update(connectedAccounts)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(eq(connectedAccounts.id, accountId))
      } catch (statusUpdateErr) {
        console.warn('[proxy] Failed to persist expired account status:', statusUpdateErr)
      }

      const reauthResult = await holdForReauth('expired')
      if (!reauthResult.ok) {
        return reauthFailureResponse(reauthResult, 'expired', (errorMessage, statusCode) =>
          audit({ statusCode, errorMessage }))
      }
      provider = getAccountProviderByName(account.providerName)
      try {
        response = await forwardRequest()
      } catch (retryError) {
        await audit({ errorMessage: `${errorLabel} after re-authentication: ${retryError}` })
        return c.json(
          { error: errorLabel, details: String(retryError), accountStatus: 'expired' },
          502,
        )
      }
    } else {
      await audit({ errorMessage: `${errorLabel}: ${error}` })
      return c.json(
        { error: errorLabel, details: String(error) },
        502
      )
    }
  }

  audit({
    statusCode: response.status,
    ...(response.status >= 400 ? { errorMessage: `Upstream returned ${response.status}` } : {}),
  })
  return response
})

export default proxy

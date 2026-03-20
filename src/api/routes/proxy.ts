import { Hono } from 'hono'
import crypto from 'crypto'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { isHostAllowed } from '@shared/lib/proxy/allowed-hosts'
import { matchScopes } from '@shared/lib/proxy/scope-matcher'
import { resolveApiPolicy } from '@shared/lib/proxy/policy-resolver'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import { getConnectionToken } from '@shared/lib/composio/client'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { db } from '@shared/lib/db'
import {
  connectedAccounts,
  agentConnectedAccounts,
  proxyAuditLog,
} from '@shared/lib/db/schema'
import { eq, and } from 'drizzle-orm'

// In-memory token cache: composioConnectionId → { accessToken, expiresAt }
const tokenCache = new Map<
  string,
  { accessToken: string; cacheExpiresAt: number }
>()

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

async function getCachedToken(composioConnectionId: string): Promise<string> {
  const cached = tokenCache.get(composioConnectionId)
  if (cached && cached.cacheExpiresAt > Date.now()) {
    return cached.accessToken
  }

  const { accessToken, expiresAt } = await getConnectionToken(
    composioConnectionId
  )

  let ttl = DEFAULT_CACHE_TTL_MS
  if (expiresAt) {
    const tokenExpiresMs = new Date(expiresAt).getTime() - Date.now()
    // Expire cache 60s before token expires, capped at 5 minutes
    ttl = Math.min(tokenExpiresMs - 60_000, DEFAULT_CACHE_TTL_MS)
  }
  // At least 30s cache to avoid hammering Composio
  ttl = Math.max(ttl, 30_000)

  tokenCache.set(composioConnectionId, {
    accessToken,
    cacheExpiresAt: Date.now() + ttl,
  })

  return accessToken
}

async function logAuditEntry(entry: {
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
}): Promise<void> {
  try {
    await db.insert(proxyAuditLog).values({
      id: crypto.randomUUID(),
      ...entry,
      statusCode: entry.statusCode ?? null,
      errorMessage: entry.errorMessage ?? null,
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
  const agentSlug = c.req.param('agentSlug')
  const accountId = c.req.param('accountId')
  const rest = c.req.param('rest') || ''

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
  const results = await db
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

  if (results.length === 0) {
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

  const account = results[0].account

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
    policyResult = await resolveApiPolicy(accountId, matchResult, userId)
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
      })
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

  // 4. Fetch real token (with cache)
  let realToken: string
  try {
    realToken = await getCachedToken(account.composioConnectionId)
  } catch (error) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: account.toolkitSlug,
      targetHost,
      targetPath,
      method: c.req.method,
      errorMessage: `Failed to fetch access token: ${error}`,
      policyDecision: resolvedPolicyDecision,
      matchedScopes: JSON.stringify(policyResult.matchedScopes),
    })
    return c.json({ error: 'Failed to fetch access token' }, 502)
  }

  // 5. Build target URL
  const queryString = new URL(c.req.url).search
  const targetUrl = `https://${targetHost}/${targetPath}${queryString}`

  // 6. Forward request
  const forwardHeaders = new Headers()
  const skipHeaders = new Set([
    'host',
    'authorization',
    'connection',
    'content-length',
    'transfer-encoding',
    'accept-encoding',
  ])

  c.req.raw.headers.forEach((value, key) => {
    if (!skipHeaders.has(key.toLowerCase())) {
      forwardHeaders.set(key, value)
    }
  })
  forwardHeaders.set('Authorization', `Bearer ${realToken}`)

  const init: RequestInit = { method, headers: forwardHeaders }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = await c.req.arrayBuffer()
  }

  let statusCode: number | undefined
  try {
    const response = await fetch(targetUrl, init)
    statusCode = response.status

    // Fire-and-forget audit log to avoid adding latency to proxied responses
    logAuditEntry({
      agentSlug,
      accountId,
      toolkit: account.toolkitSlug,
      targetHost,
      targetPath,
      method,
      statusCode,
      policyDecision: resolvedPolicyDecision,
      matchedScopes: JSON.stringify(policyResult.matchedScopes),
    })

    // Pass response through
    const responseHeaders = new Headers()
    const skipResponseHeaders = new Set([
      'transfer-encoding',
      'content-encoding', // fetch() auto-decompresses, so body is already decoded
      'content-length', // length changes after decompression
    ])
    response.headers.forEach((value, key) => {
      if (!skipResponseHeaders.has(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    })

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (error) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: account.toolkitSlug,
      targetHost,
      targetPath,
      method,
      errorMessage: `Proxy request failed: ${error}`,
      policyDecision: resolvedPolicyDecision,
      matchedScopes: JSON.stringify(policyResult.matchedScopes),
    })
    return c.json(
      { error: 'Proxy request failed', details: String(error) },
      502
    )
  }
})

export default proxy

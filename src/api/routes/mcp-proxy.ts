import { Hono } from 'hono'
import crypto from 'crypto'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { resolveMcpPolicy } from '@shared/lib/proxy/policy-resolver'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import { mcpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import { isReauthDismissed, reauthDismissalReason, withDismissalReason } from '@shared/lib/proxy/reauth-dismissal'
import { db } from '@shared/lib/db'
import {
  remoteMcpServers,
  agentRemoteMcps,
  mcpAuditLog,
} from '@shared/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { mcpSafeFetch } from '@shared/lib/mcp/mcp-safe-fetch'
import { parseMcpResponse } from '@shared/lib/mcp/discover-tools'

const SYNTHETIC_MCP_SESSION_TTL_MS = 24 * 60 * 60 * 1000

interface SyntheticMcpSession {
  mcpId: string
  protocolVersion: string
  upstreamSessionId: string | null | undefined
  initializationPromise?: Promise<string | null>
  lastUsedAt: number
}

class McpSessionInitializationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'McpSessionInitializationError'
  }
}

// The SDK must receive a session id from the local initialize stub so it keeps
// sending one after re-authentication. We bind that stable client-facing id to
// the real upstream id lazily, once fresh credentials are available.
const syntheticMcpSessions = new Map<string, SyntheticMcpSession>()

function pruneSyntheticMcpSessions(now = Date.now()): void {
  for (const [id, session] of syntheticMcpSessions) {
    if (now - session.lastUsedAt > SYNTHETIC_MCP_SESSION_TTL_MS) {
      syntheticMcpSessions.delete(id)
    }
  }
}

function createSyntheticMcpSession(mcpId: string, protocolVersion: string): string {
  pruneSyntheticMcpSessions()
  const id = crypto.randomUUID()
  syntheticMcpSessions.set(id, {
    mcpId,
    protocolVersion,
    upstreamSessionId: undefined,
    lastUsedAt: Date.now(),
  })
  return id
}

function getSyntheticMcpSession(
  mcpId: string,
  clientSessionId: string | undefined,
): SyntheticMcpSession | null {
  if (!clientSessionId) return null
  const session = syntheticMcpSessions.get(clientSessionId)
  if (!session || session.mcpId !== mcpId) return null
  if (Date.now() - session.lastUsedAt > SYNTHETIC_MCP_SESSION_TTL_MS) {
    syntheticMcpSessions.delete(clientSessionId)
    return null
  }
  session.lastUsedAt = Date.now()
  return session
}

async function initializeUpstreamSession(options: {
  session: SyntheticMcpSession
  targetUrl: string
  accessToken: string | null
  headers: Headers
}): Promise<string | null> {
  const { session, targetUrl, accessToken } = options
  if (session.upstreamSessionId !== undefined) return session.upstreamSessionId
  if (session.initializationPromise) return session.initializationPromise

  const initializationPromise = (async () => {
    const headers = new Headers(options.headers)
    headers.delete('Mcp-Session-Id')
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'application/json, text/event-stream')
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

    const initializeResponse = await mcpSafeFetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `superagent-reauth-${crypto.randomUUID()}`,
        method: 'initialize',
        params: {
          protocolVersion: session.protocolVersion,
          capabilities: {},
          clientInfo: { name: 'SuperAgent MCP proxy', version: '1.0.0' },
        },
      }),
    })

    if (!initializeResponse.ok) {
      await initializeResponse.body?.cancel().catch(() => undefined)
      throw new McpSessionInitializationError(
        `MCP session re-initialization failed with status ${initializeResponse.status}`,
        initializeResponse.status,
      )
    }

    const upstreamSessionId = initializeResponse.headers.get('Mcp-Session-Id')
    try {
      await parseMcpResponse(initializeResponse)
    } catch (error) {
      throw new McpSessionInitializationError(
        `MCP session re-initialization returned an invalid response: ${error}`,
      )
    }

    const initializedHeaders = new Headers(headers)
    if (upstreamSessionId) {
      initializedHeaders.set('Mcp-Session-Id', upstreamSessionId)
    }
    const initializedResponse = await mcpSafeFetch(targetUrl, {
      method: 'POST',
      headers: initializedHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    })
    if (!initializedResponse.ok) {
      await initializedResponse.body?.cancel().catch(() => undefined)
      throw new McpSessionInitializationError(
        `MCP initialized notification failed with status ${initializedResponse.status}`,
        initializedResponse.status,
      )
    }
    await initializedResponse.body?.cancel().catch(() => undefined)
    session.upstreamSessionId = upstreamSessionId
    session.lastUsedAt = Date.now()
    return upstreamSessionId
  })()

  session.initializationPromise = initializationPromise
  try {
    return await initializationPromise
  } finally {
    session.initializationPromise = undefined
  }
}

async function logMcpAuditEntry(entry: {
  agentSlug: string
  remoteMcpId: string
  remoteMcpName: string
  method: string
  requestPath: string
  statusCode?: number
  errorMessage?: string
  durationMs?: number
  policyDecision?: string
  matchedTool?: string
}): Promise<void> {
  try {
    await db.insert(mcpAuditLog).values({
      id: crypto.randomUUID(),
      ...entry,
      statusCode: entry.statusCode ?? null,
      errorMessage: entry.errorMessage ?? null,
      durationMs: entry.durationMs ?? null,
      policyDecision: entry.policyDecision ?? null,
      matchedTool: entry.matchedTool ?? null,
      createdAt: new Date(),
    })
  } catch (error) {
    console.error('[mcp-proxy] Failed to write audit log:', error)
  }
}

// GET listen must be SSE or 405; 200+HTML (Attio) makes Claude Agent SDK reconnect forever.
function isSseContentType(contentType: string | null): boolean {
  return (contentType ?? '').toLowerCase().includes('text/event-stream')
}

function shouldRewriteNonSseGet(method: string, response: Response): boolean {
  return method === 'GET' && response.status === 200 && !isSseContentType(response.headers.get('content-type'))
}

/**
 * Attempt to refresh an expired OAuth token.
 * Returns the new access token on success, null on failure.
 */
async function tryRefreshToken(mcp: {
  id: string
  refreshToken: string | null
  oauthTokenEndpoint: string | null
  oauthClientId: string | null
  oauthClientSecret: string | null
  oauthResource: string | null
}): Promise<string | null> {
  if (!mcp.refreshToken || !mcp.oauthTokenEndpoint || !mcp.oauthClientId) {
    return null
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: mcp.refreshToken,
      client_id: mcp.oauthClientId,
    })
    if (mcp.oauthClientSecret) {
      body.set('client_secret', mcp.oauthClientSecret)
    }
    if (mcp.oauthResource) {
      body.set('resource', mcp.oauthResource)
    }

    const res = await mcpSafeFetch(mcp.oauthTokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    if (!res.ok) return null

    const data = (await res.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
    }

    const now = new Date()
    const expiresAt = data.expires_in
      ? new Date(now.getTime() + data.expires_in * 1000)
      : null

    await db
      .update(remoteMcpServers)
      .set({
        accessToken: data.access_token,
        refreshToken: data.refresh_token || mcp.refreshToken,
        tokenExpiresAt: expiresAt,
        status: 'active',
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(remoteMcpServers.id, mcp.id))

    mcpReauthManager.completeMcp(mcp.id)

    return data.access_token
  } catch {
    return null
  }
}

const mcpProxy = new Hono()

// Catch-all route: /api/mcp-proxy/:agentSlug/:mcpId and optional trailing path
/**
 * How each way of failing a parked re-auth is reported to the agent. Split out
 * of the response builder because three parallel ternaries over the same four
 * cases is a place for them to drift apart.
 *
 * `dismissed` is deliberately a 403, not the 408 the timeout returns: a person
 * decided this, and a timeout reads to an agent as an invitation to retry.
 */
const MCP_REAUTH_FAILURES = {
  timeout: {
    statusCode: 408,
    error: 'mcp_reauth_timeout',
    message: 'The request timed out while waiting for the MCP server to be reconnected.',
  },
  dismissed: {
    statusCode: 403,
    error: 'mcp_reauth_dismissed',
    message: 'A user dismissed the reconnection request, so this call was not made. '
      + 'Do not retry it until the MCP server is reconnected.',
  },
  missing: {
    statusCode: 404,
    error: 'mcp_reauth_failed',
    message: 'The MCP server disappeared while re-authenticating.',
  },
  inactive: {
    statusCode: 502,
    error: 'mcp_reauth_failed',
    message: 'The MCP server did not become active after re-authentication.',
  },
} as const

mcpProxy.all('/:agentSlug/:mcpId/:rest{.*}?', async (c) => {
  const agentSlug = c.req.param('agentSlug')
  const mcpId = c.req.param('mcpId')
  const rest = c.req.param('rest') || ''
  const startTime = Date.now()

  // 1. Validate proxy token
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  const synthToken = authHeader.slice(7)
  const validatedAgent = await validateProxyToken(synthToken)
  if (!validatedAgent) {
    return c.json({ error: 'Invalid proxy token' }, 401)
  }

  if (validatedAgent !== agentSlug) {
    return c.json({ error: 'Token does not match agent' }, 403)
  }

  // 2. Verify agent-MCP mapping exists
  const loadMappedMcp = async () => {
    const [mapping] = await db
      .select({ mcp: remoteMcpServers })
      .from(agentRemoteMcps)
      .innerJoin(
        remoteMcpServers,
        eq(agentRemoteMcps.remoteMcpId, remoteMcpServers.id)
      )
      .where(
        and(
          eq(agentRemoteMcps.agentSlug, agentSlug),
          eq(agentRemoteMcps.remoteMcpId, mcpId)
        )
      )
      .limit(1)
    return mapping?.mcp ?? null
  }

  let mcp = await loadMappedMcp()
  if (!mcp) {
    return c.json({ error: 'MCP server not found or not assigned to this agent' }, 404)
  }

  const method = c.req.method
  const clientMcpSessionId = c.req.header('Mcp-Session-Id')

  // 2.5 Parse JSON-RPC body early for policy enforcement and audit logging
  let bodyBuffer: ArrayBuffer | undefined
  let mcpMethodInfo = rest || '/'
  let toolName: string | null = null
  let jsonRpcId: string | number | null = null
  let requestedProtocolVersion = '2025-03-26'
  if (method !== 'GET' && method !== 'HEAD') {
    bodyBuffer = await c.req.arrayBuffer()
    try {
      const text = new TextDecoder().decode(bodyBuffer)
      const jsonRpc = JSON.parse(text) as {
        id?: string | number | null
        method?: string
        params?: { name?: string; protocolVersion?: string }
      }
      if (
        typeof jsonRpc.id === 'string' ||
        typeof jsonRpc.id === 'number' ||
        jsonRpc.id === null
      ) {
        jsonRpcId = jsonRpc.id
      }
      if (typeof jsonRpc.params?.protocolVersion === 'string') {
        requestedProtocolVersion = jsonRpc.params.protocolVersion
      }
      if (jsonRpc.method) {
        mcpMethodInfo = jsonRpc.method
        if (jsonRpc.method === 'tools/call' && jsonRpc.params?.name) {
          toolName = jsonRpc.params.name
          mcpMethodInfo = `tools/call: ${toolName}`
        }
      }
    } catch {
      // Not JSON or not JSON-RPC — keep the HTTP path
    }
  }

  type ReauthResult =
    | { ok: true }
    // See the account proxy for `dismissReason`.
    | { ok: false; reason: 'timeout' | 'dismissed' | 'missing' | 'inactive'; dismissReason?: string }

  const holdForReauth = async (): Promise<ReauthResult> => {
    try {
      await mcpReauthManager.requestReauth({
        agentSlug,
        mcpId,
        mcpName: mcp!.name,
        authType: mcp!.authType,
      }, c.req.raw.signal)
    } catch (error) {
      // See the account proxy: a dismissal is a decision, not a stalled wait.
      if (isReauthDismissed(error)) {
        return { ok: false, reason: 'dismissed', dismissReason: reauthDismissalReason(error) }
      }
      return { ok: false, reason: 'timeout' }
    }

    const refreshed = await loadMappedMcp()
    if (!refreshed) return { ok: false, reason: 'missing' }
    if (refreshed.status !== 'active') return { ok: false, reason: 'inactive' }
    mcp = refreshed
    return { ok: true }
  }

  const reauthFailureResponse = async (
    result: Exclude<ReauthResult, { ok: true }>,
  ) => {
    const failure = MCP_REAUTH_FAILURES[result.reason]
    const { statusCode, error } = failure
    const message = withDismissalReason(failure.message, result.dismissReason)

    await logMcpAuditEntry({
      agentSlug,
      remoteMcpId: mcpId,
      remoteMcpName: mcp?.name ?? mcpId,
      method,
      requestPath: mcpMethodInfo,
      statusCode,
      errorMessage: message,
      durationMs: Date.now() - startTime,
      matchedTool: toolName ?? undefined,
    })

    return c.json({ error, message, mcpStatus: 'auth_required' }, statusCode)
  }

  const markAuthRequired = async (errorMessage: string) => {
    await db
      .update(remoteMcpServers)
      .set({
        status: 'auth_required',
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(remoteMcpServers.id, mcpId))
  }

  const cachedTools = () => {
    if (!mcp?.toolsJson) return []
    try {
      const parsed = JSON.parse(mcp.toolsJson) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((tool) => {
        if (
          typeof tool !== 'object' ||
          tool === null ||
          !('name' in tool) ||
          typeof tool.name !== 'string'
        ) {
          return []
        }
        const description = 'description' in tool && typeof tool.description === 'string'
          ? tool.description
          : undefined
        const inputSchema = 'inputSchema' in tool &&
          typeof tool.inputSchema === 'object' &&
          tool.inputSchema !== null
          ? tool.inputSchema
          : { type: 'object', additionalProperties: true }
        return [{ name: tool.name, description, inputSchema }]
      })
    } catch {
      return []
    }
  }

  // Let the SDK complete its eager MCP handshake without contacting an
  // upstream server whose credentials are known to be invalid. We advertise
  // cached tool definitions, then park only the eventual tools/call. This
  // preserves a seamless reconnect/resume flow without freezing session init
  // or unrelated chat turns.
  const authRequiredProtocolResponse = (): Response | null => {
    if ((method === 'GET' || method === 'HEAD') && !rest) {
      return new Response(null, { status: 405, headers: { Allow: 'POST' } })
    }
    if (mcpMethodInfo.startsWith('notifications/')) {
      return new Response(null, { status: 202 })
    }
    if (mcpMethodInfo === 'initialize') {
      const syntheticSessionId = createSyntheticMcpSession(
        mcpId,
        requestedProtocolVersion,
      )
      const response = c.json({
        jsonrpc: '2.0',
        id: jsonRpcId,
        result: {
          protocolVersion: requestedProtocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: mcp!.name, version: '1.0.0' },
        },
      })
      response.headers.set('Mcp-Session-Id', syntheticSessionId)
      return response
    }
    if (mcpMethodInfo === 'tools/list') {
      return c.json({
        jsonrpc: '2.0',
        id: jsonRpcId,
        result: { tools: cachedTools() },
      })
    }
    if (mcpMethodInfo === 'ping') {
      return c.json({ jsonrpc: '2.0', id: jsonRpcId, result: {} })
    }
    return null
  }

  // A previously failed request may already have marked this server. Complete
  // eager protocol discovery locally without entering the authorization path.
  // Non-protocol calls are parked only after their policy gate below.
  if (mcp.status === 'auth_required') {
    const protocolResponse = authRequiredProtocolResponse()
    if (protocolResponse) return protocolResponse
  }

  // 2.6 Policy enforcement
  // Skip review for MCP protocol-level methods (handshake, discovery, pings).
  // Only tool invocations (tools/call) need policy checks.
  const MCP_PROTOCOL_METHODS = new Set([
    'initialize',
    'ping',
    'tools/list',
    'prompts/list',
    'resources/list',
    'resources/templates/list',
    'logging/setLevel',
    'completion/complete',
    'roots/list',
  ])
  // GET/HEAD requests are SSE transport setup — always protocol-level.
  // All `notifications/*` are fire-and-forget protocol chatter with no data transfer.
  const isProtocolMethod =
    method === 'GET' ||
    method === 'HEAD' ||
    MCP_PROTOCOL_METHODS.has(mcpMethodInfo) ||
    mcpMethodInfo.startsWith('notifications/')

  const userId = mcp.userId ?? 'local'
  let resolvedPolicyDecision: string = 'allow'

  if (!isProtocolMethod) {
    let policyResult
    try {
      policyResult = await resolveMcpPolicy(mcpId, toolName, userId)
    } catch (policyError) {
      console.error('[mcp-proxy] Policy enforcement failed, defaulting to review:', policyError)
      policyResult = { decision: 'review' as const, matchedScopes: [] as string[], scopeDescriptions: {} as Record<string, string>, resolvedFrom: 'global_default' as const }
    }

    if (policyResult.decision === 'block') {
      await logMcpAuditEntry({
        agentSlug,
        remoteMcpId: mcp.id,
        remoteMcpName: mcp.name,
        method,
        requestPath: mcpMethodInfo,
        policyDecision: 'block',
        matchedTool: toolName ?? undefined,
      })
      return c.json({
        error: 'blocked_by_policy',
        message: 'This request was blocked by your MCP access policy.',
        tool: toolName,
        settingsHint: 'You can adjust policies in Settings > MCP Servers > Policies',
      }, 403)
    }

    resolvedPolicyDecision = policyResult.decision

    if (policyResult.decision === 'review') {
      try {
        const decision = await reviewManager.requestReview({
          agentSlug,
          accountId: mcpId,
          toolkit: mcp.name,
          method,
          targetPath: mcpMethodInfo,
          matchedScopes: policyResult.matchedScopes,
          scopeDescriptions: policyResult.scopeDescriptions,
        }, c.req.raw.signal)
        if (decision === 'deny') {
          await logMcpAuditEntry({
            agentSlug,
            remoteMcpId: mcp.id,
            remoteMcpName: mcp.name,
            method,
            requestPath: mcpMethodInfo,
            policyDecision: 'denied_by_user',
            matchedTool: toolName ?? undefined,
          })
          return c.json({ error: 'denied_by_user', message: 'Request denied by user.' }, 403)
        }
        resolvedPolicyDecision = 'approved_by_user'
      } catch {
        await logMcpAuditEntry({
          agentSlug,
          remoteMcpId: mcp.id,
          remoteMcpName: mcp.name,
          method,
          requestPath: mcpMethodInfo,
          policyDecision: 'review_timeout',
          matchedTool: toolName ?? undefined,
        })
        return c.json({ error: 'review_timeout', message: 'Request required user approval but timed out.' }, 408)
      }
    }
  }

  // Re-authentication cannot make a policy-blocked tool call permissible.
  // Wait only after policy enforcement so blocked calls remain immediate 403s
  // and cannot raise reconnect prompts.
  if (mcp.status === 'auth_required') {
    const reauthResult = await holdForReauth()
    if (!reauthResult.ok) return reauthFailureResponse(reauthResult)
  }

  // 3. Get access token, refreshing if expired
  let accessToken = mcp.accessToken
  if (mcp.authType !== 'none') {
    if (
      mcp.tokenExpiresAt &&
      mcp.tokenExpiresAt.getTime() < Date.now() &&
      mcp.refreshToken
    ) {
      accessToken = await tryRefreshToken(mcp)
      if (!accessToken) {
        await markAuthRequired('Token refresh failed')
        const protocolResponse = authRequiredProtocolResponse()
        if (protocolResponse) return protocolResponse
        const reauthResult = await holdForReauth()
        if (!reauthResult.ok) return reauthFailureResponse(reauthResult)
        accessToken = mcp.accessToken
        if (!accessToken) return reauthFailureResponse({ ok: false, reason: 'inactive' })
      }
    }

    if (!accessToken) {
      await markAuthRequired('MCP server has no access token configured')
      const protocolResponse = authRequiredProtocolResponse()
      if (protocolResponse) return protocolResponse
      const reauthResult = await holdForReauth()
      if (!reauthResult.ok) return reauthFailureResponse(reauthResult)
      accessToken = mcp.accessToken
      if (!accessToken) return reauthFailureResponse({ ok: false, reason: 'inactive' })
    }
  }

  // 4. Build target URL
  // The MCP server URL is the base; append the rest path if any
  const baseUrl = mcp.url.replace(/\/$/, '')
  const targetPath = rest ? `/${rest}` : ''
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const queryString = new URL(c.req.url).search
  const targetUrl = `${baseUrl}${targetPath}${queryString}`

  // 5. Forward request
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

  const syntheticSession = getSyntheticMcpSession(mcpId, clientMcpSessionId)

  const forwardRequest = async () => {
    const headers = new Headers(forwardHeaders)
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
    if (syntheticSession) {
      const upstreamSessionId = await initializeUpstreamSession({
        session: syntheticSession,
        targetUrl,
        accessToken,
        headers,
      })
      headers.delete('Mcp-Session-Id')
      if (upstreamSessionId) headers.set('Mcp-Session-Id', upstreamSessionId)
    }
    const init: RequestInit = { method, headers }
    if (bodyBuffer) init.body = bodyBuffer
    return mcpSafeFetch(targetUrl, init)
  }

  try {
    let response = await forwardRequest()

    // A live server can discover token revocation only when it handles the
    // request. Hold the original call, reconnect, then retry it exactly once.
    if (response.status === 401) {
      try {
        await response.body?.cancel()
      } catch (err) {
        console.warn('[mcp-proxy] Failed to cancel unauthorized response body:', err)
      }
      await markAuthRequired('Remote server returned 401')
      if (syntheticSession) syntheticSession.upstreamSessionId = undefined
      const protocolResponse = authRequiredProtocolResponse()
      if (protocolResponse) return protocolResponse
      const reauthResult = await holdForReauth()
      if (!reauthResult.ok) return reauthFailureResponse(reauthResult)
      accessToken = mcp.accessToken
      response = await forwardRequest()
    }

    const durationMs = Date.now() - startTime

    if (shouldRewriteNonSseGet(method, response)) {
      const upstreamType = response.headers.get('content-type') ?? 'missing'
      try {
        await response.body?.cancel()
      } catch (err) {
        console.warn('[mcp-proxy] Failed to cancel non-SSE GET body:', err)
      }
      logMcpAuditEntry({
        agentSlug,
        remoteMcpId: mcp.id,
        remoteMcpName: mcp.name,
        method,
        requestPath: mcpMethodInfo,
        statusCode: 405,
        errorMessage: `rewrote non-SSE GET 200 (${upstreamType}) to 405`,
        durationMs,
        policyDecision: resolvedPolicyDecision,
        matchedTool: toolName ?? undefined,
      })
      return new Response(null, {
        status: 405,
        headers: { Allow: 'POST' },
      })
    }

    // Fire-and-forget audit log
    logMcpAuditEntry({
      agentSlug,
      remoteMcpId: mcp.id,
      remoteMcpName: mcp.name,
      method,
      requestPath: mcpMethodInfo,
      statusCode: response.status,
      durationMs,
      policyDecision: resolvedPolicyDecision,
      matchedTool: toolName ?? undefined,
    })

    // A failed retry stays marked, but is returned rather than opening an
    // unbounded second reconnect loop for the same proxy request.
    if (response.status === 401) {
      markAuthRequired('Remote server returned 401').catch(() => {})
    }

    if (method === 'DELETE' && clientMcpSessionId && syntheticSession) {
      syntheticMcpSessions.delete(clientMcpSessionId)
    }

    // Pass response through (including SSE streams)
    const responseHeaders = new Headers()
    const skipResponseHeaders = new Set([
      'transfer-encoding',
      'content-encoding',
      'content-length',
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
    const durationMs = Date.now() - startTime
    const sessionInitializationFailed = error instanceof McpSessionInitializationError
    if (sessionInitializationFailed && error.status === 401) {
      await markAuthRequired('MCP session re-initialization returned 401')
    }
    await logMcpAuditEntry({
      agentSlug,
      remoteMcpId: mcp.id,
      remoteMcpName: mcp.name,
      method,
      requestPath: mcpMethodInfo,
      errorMessage: `Proxy request failed: ${error}`,
      durationMs,
      policyDecision: resolvedPolicyDecision,
      matchedTool: toolName ?? undefined,
    })
    if (sessionInitializationFailed) {
      return c.json({
        error: 'mcp_session_reinitialize_failed',
        message: 'The MCP was reconnected, but its session could not be re-initialized. Retry this tool call.',
        details: error.message,
      }, 502)
    }
    return c.json(
      { error: 'MCP proxy request failed', details: String(error) },
      502
    )
  }
})

export default mcpProxy

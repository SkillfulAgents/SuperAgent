import { Hono } from 'hono'
import crypto from 'crypto'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { withUserReason } from '@shared/lib/proxy/user-reason'
import { db } from '@shared/lib/db'
import { mcpAuditLog } from '@shared/lib/db/schema'
import { mcpSafeFetch } from '@shared/lib/mcp/mcp-safe-fetch'
import { background } from '@shared/lib/background'
import { parseMcpResponse } from '@shared/lib/mcp/discover-tools'
import { resolveMcpConnection } from '@shared/lib/mcp/connections'
import type { McpAuthorization, McpRecoveryResult } from '@shared/lib/mcp/connection-types'
import { agentRegistry, type AgentActor } from '@shared/lib/agent-actor'

// MCP 2026-07-28 clients (Claude Code CLI 2.1.274+ by default) open every
// connection with a `server/discover` era probe before `initialize`. It carries
// no data and a server that predates the era answers it with a JSON-RPC
// "method not found", after which the client falls back to the classic
// handshake. Treat it as protocol chatter: without this every remote MCP
// server raised an "Allow POST request?" review card per session.
const MCP_ERA_PROBE_METHOD = 'server/discover'

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
// sending one after re-authentication. That stable client-facing id is bound
// to the real upstream id lazily, once fresh credentials are available. The
// sessions are the agent's (`actor.mcpSessions`).

/**
 * The upstream session a proxy-opened session speaks for now, initializing one
 * if it has none. The binding is read here, at the point of use, never from
 * the request's start: another request may have reconnected and bound a new
 * upstream session while this one waited for authorization. One
 * initialization at a time per session: a request that waited behind another
 * reads what that one bound. `handshake` says the binding was not there on
 * arrival, so the caller's credentials predate the wait.
 */
async function upstreamSessionFor(options: {
  actor: AgentActor
  mcpId: string
  sessionId: string
  protocolVersion: string
  targetUrl: string
  accessToken: string | null
  headers: Headers
  signal?: AbortSignal
}): Promise<{ upstreamSessionId: string | null; handshake: boolean }> {
  const { actor, mcpId, sessionId, targetUrl, accessToken } = options
  const current = await actor.mcpSessions.get(mcpId, sessionId)
  if (current && current.upstreamSessionId !== undefined) return { upstreamSessionId: current.upstreamSessionId, handshake: false }

  const lockKey = `mcp-session-init:${sessionId}`
  const lock = await actor.locks.acquire(lockKey)
  try {
    // Gone since the request read it (expired): initialize for this request alone.
    const session = await actor.mcpSessions.get(mcpId, sessionId)
    if (session && session.upstreamSessionId !== undefined) return { upstreamSessionId: session.upstreamSessionId, handshake: true }

    const headers = new Headers(options.headers)
    headers.delete('Mcp-Session-Id')
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'application/json, text/event-stream')
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

    const initializeResponse = await mcpSafeFetch(targetUrl, {
      signal: options.signal,
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `superagent-reauth-${crypto.randomUUID()}`,
        method: 'initialize',
        params: {
          protocolVersion: session?.protocolVersion ?? options.protocolVersion,
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
      signal: options.signal,
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
    await actor.mcpSessions.bind(sessionId, upstreamSessionId)
    return { upstreamSessionId, handshake: true }
  } finally {
    await actor.locks.release(lockKey, lock)
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
  ruleVersionId?: string
  ruleOutcomes?: string
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
      ruleVersionId: entry.ruleVersionId ?? null,
      ruleOutcomes: entry.ruleOutcomes ?? null,
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

  const resolved = await resolveMcpConnection(agentSlug, mcpId)
  if (!resolved.ok) {
    return resolved.reason === 'unavailable'
      ? c.json({ error: 'MCP connection unavailable' }, 403)
      : c.json({ error: 'MCP server not found or not assigned to this agent' }, 404)
  }
  const mcp = resolved.connection

  const method = c.req.method
  const clientMcpSessionId = c.req.header('Mcp-Session-Id')
  // The proxy's own sessions with this MCP are the agent's.
  const actor = agentRegistry.get(agentSlug)

  // 2.5 Parse JSON-RPC body early for policy enforcement and audit logging
  let bodyBuffer: ArrayBuffer | undefined
  let mcpMethodInfo = rest || '/'
  let toolName: string | null = null
  let toolArgs: unknown
  let jsonRpcId: string | number | null = null
  let requestedProtocolVersion = '2025-03-26'
  if (method !== 'GET' && method !== 'HEAD') {
    bodyBuffer = await c.req.arrayBuffer()
    try {
      const text = new TextDecoder().decode(bodyBuffer)
      const jsonRpc = JSON.parse(text) as {
        id?: string | number | null
        method?: string
        params?: { name?: string; protocolVersion?: string; arguments?: unknown }
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
          toolArgs = jsonRpc.params.arguments
          mcpMethodInfo = `tools/call: ${toolName}`
        }
      }
    } catch {
      // Not JSON or not JSON-RPC — keep the HTTP path
    }
  }

  const reauthFailureResponse = async (
    result: Exclude<McpRecoveryResult, { ok: true }>,
  ) => {
    if (result.reason === 'reconnect_required') {
      await logMcpAuditEntry({ agentSlug, remoteMcpId: mcpId, remoteMcpName: mcp.descriptor.name,
        method, requestPath: mcpMethodInfo, statusCode: 409, errorMessage: result.message,
        durationMs: Date.now() - startTime, matchedTool: toolName ?? undefined })
      return c.json({ error: result.error, message: result.message, ...result.context }, 409)
    }
    if (result.reason === 'replaced') {
      const message = `This MCP connection was replaced. Use the tools for MCP ID ${result.replacementMcpId} instead of ${mcpId}.`
      await logMcpAuditEntry({
        agentSlug, remoteMcpId: mcpId, remoteMcpName: mcp.descriptor.name,
        method, requestPath: mcpMethodInfo, statusCode: 409, errorMessage: message,
        durationMs: Date.now() - startTime, matchedTool: toolName ?? undefined,
      })
      return c.json({ error: 'mcp_replaced', message, replacementMcpId: result.replacementMcpId }, 409)
    }
    const failure = MCP_REAUTH_FAILURES[result.reason]
    const { statusCode, error } = failure
    const message = withUserReason(failure.message, result.dismissReason)

    await logMcpAuditEntry({
      agentSlug,
      remoteMcpId: mcpId,
      remoteMcpName: mcp.descriptor.name,
      method,
      requestPath: mcpMethodInfo,
      statusCode,
      errorMessage: message,
      durationMs: Date.now() - startTime,
      matchedTool: toolName ?? undefined,
    })

    return c.json({ error, message, mcpStatus: 'auth_required' }, statusCode)
  }

  // Let the SDK complete its eager MCP handshake without contacting an
  // upstream server whose credentials are known to be invalid. We advertise
  // cached tool definitions, then park only the eventual tools/call. This
  // preserves a seamless reconnect/resume flow without freezing session init
  // or unrelated chat turns.
  const authRequiredProtocolResponse = async (): Promise<Response | null> => {
    if ((method === 'GET' || method === 'HEAD') && !rest) {
      return new Response(null, { status: 405, headers: { Allow: 'POST' } })
    }
    if (mcpMethodInfo.startsWith('notifications/')) {
      return new Response(null, { status: 202 })
    }
    if (mcpMethodInfo === 'initialize') {
      const syntheticSessionId = await actor.mcpSessions.open(mcpId, requestedProtocolVersion)
      const response = c.json({
        jsonrpc: '2.0',
        id: jsonRpcId,
        result: {
          protocolVersion: requestedProtocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: mcp.descriptor.name, version: '1.0.0' },
        },
      })
      response.headers.set('Mcp-Session-Id', syntheticSessionId)
      return response
    }
    if (mcpMethodInfo === 'tools/list') {
      return c.json({
        jsonrpc: '2.0',
        id: jsonRpcId,
        result: { tools: mcp.descriptor.tools },
      })
    }
    if (mcpMethodInfo === 'ping') {
      return c.json({ jsonrpc: '2.0', id: jsonRpcId, result: {} })
    }
    if (mcpMethodInfo === MCP_ERA_PROBE_METHOD) {
      // A pre-2026-07-28 server answers the era probe with "method not
      // found"; the client then negotiates through `initialize` as before.
      return c.json({
        jsonrpc: '2.0',
        id: jsonRpcId,
        error: { code: -32601, message: `Method not found: ${MCP_ERA_PROBE_METHOD}` },
      })
    }
    return null
  }

  // A previously failed request may already have marked this server. Complete
  // eager protocol discovery locally without entering the authorization path.
  // Non-protocol calls are parked only after their policy gate below.
  if (mcp.descriptor.status === 'auth_required') {
    const protocolResponse = await authRequiredProtocolResponse()
    if (protocolResponse) return protocolResponse
  }

  // 2.6 Policy enforcement
  // Skip review for MCP protocol-level methods (handshake, discovery, pings).
  // Only tool invocations (tools/call) need policy checks.
  const MCP_PROTOCOL_METHODS = new Set([
    'initialize',
    MCP_ERA_PROBE_METHOD,
    'ping',
    'tools/list',
    'prompts/list',
    'resources/list',
    'resources/templates/list',
    'logging/setLevel',
    'completion/complete',
    'roots/list',
    // MCP 2026-07-28 notification stream; replaces the auto-allowed GET SSE stream.
    'subscriptions/listen',
  ])
  // GET/HEAD requests are SSE transport setup — always protocol-level.
  // All `notifications/*` are fire-and-forget protocol chatter with no data transfer.
  const isProtocolMethod =
    method === 'GET' ||
    method === 'HEAD' ||
    MCP_PROTOCOL_METHODS.has(mcpMethodInfo) ||
    mcpMethodInfo.startsWith('notifications/')

  const access = await mcp.authorizeInvocation({
    method, requestPath: mcpMethodInfo, toolName, args: toolArgs, isProtocolMethod, signal: c.req.raw.signal,
  })
  if (!access.ok) {
    const failures = {
      blocked: { status: 403, policyDecision: 'block', body: {
        error: 'blocked_by_policy', message: 'This request was blocked by your MCP access policy.',
        tool: toolName, settingsHint: `You can change this on the agent's Connections page: open ${mcp.descriptor.name} and edit its Permissions.`,
      } },
      denied: { status: 403, policyDecision: 'denied_by_user', body: { error: 'denied_by_user', message: withUserReason('Request denied by user.', access.denyReason), rules: access.rules ?? [] } },
      review_timeout: { status: 408, policyDecision: 'review_timeout', body: { error: 'review_timeout', message: 'Request required user approval but timed out.', rules: access.rules ?? [] } },
      rules_unavailable: { status: 503, policyDecision: 'rules_unavailable', body: { error: 'rules_unavailable', message: 'Proxy rules could not be checked. Try again shortly.' } },
    } as const
    const failure = failures[access.reason]
    await logMcpAuditEntry({ agentSlug, remoteMcpId: mcp.descriptor.id, remoteMcpName: mcp.descriptor.name,
      method, requestPath: mcpMethodInfo, policyDecision: failure.policyDecision, matchedTool: toolName ?? undefined,
      ruleVersionId: access.ruleVersionId, ruleOutcomes: access.ruleOutcomes })
    return c.json(failure.body, failure.status)
  }
  const resolvedPolicyDecision = access.policyDecision
  const ruleAudit = { ruleVersionId: access.ruleVersionId, ruleOutcomes: access.ruleOutcomes }

  // Re-authentication cannot make a policy-blocked tool call permissible.
  // Wait only after policy enforcement so blocked calls remain immediate 403s
  // and cannot raise reconnect prompts.
  if (mcp.descriptor.status === 'auth_required') {
    const reauthResult = await mcp.recoverAuthorization(c.req.raw.signal)
    if (!reauthResult.ok) return reauthFailureResponse(reauthResult)
  }

  // Resolve credentials through the source, preserving cached protocol replies
  // and one bounded recovery when refresh discovers that reconnect is needed.
  const prepareAuthorization = async (): Promise<Extract<McpAuthorization, { ok: true }> | Response> => {
    const authorization = await mcp.authorization()
    if (authorization.ok) return authorization
    const protocolResponse = await authRequiredProtocolResponse()
    if (protocolResponse) return protocolResponse
    const recovered = await mcp.recoverAuthorization(c.req.raw.signal)
    if (!recovered.ok) return reauthFailureResponse(recovered)
    const refreshed = await mcp.authorization()
    return refreshed.ok ? refreshed : reauthFailureResponse({ ok: false, reason: 'inactive' })
  }

  const targetPath = rest ? `/${rest}` : ''
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const queryString = new URL(c.req.url).search

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

  // A session the proxy opened while the server needed re-authentication. What
  // it is bound to upstream is read where it is used (`upstreamSessionFor`).
  const syntheticSession = clientMcpSessionId ? await actor.mcpSessions.get(mcpId, clientMcpSessionId) : null
  // The upstream session this request's last forward went out on.
  let forwardedOn: string | null = null

  // Only failures while talking to the upstream affect its health. Parent
  // authorization, local lifecycle changes and cancelled callers do not.
  const requestUpstream = async <T>(request: () => Promise<T>): Promise<T> => {
    try { return await request() }
    catch (error) {
      const cancelled = c.req.raw.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      const rejected = error instanceof McpSessionInitializationError && error.status !== undefined && error.status < 500
      if (!cancelled && !rejected) await mcp.reportHealth(false).catch(() => {})
      throw error
    }
  }

  const forwardRequest = async (authorization: Extract<McpAuthorization, { ok: true }>) => {
    let accessToken = authorization.accessToken
    const targetUrl = `${mcp.descriptor.url.replace(/\/$/, '')}${targetPath}${queryString}`

    const headers = new Headers(forwardHeaders)
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
    if (syntheticSession && clientMcpSessionId) {
      const { upstreamSessionId, handshake } = await requestUpstream(() => upstreamSessionFor({
        actor,
        mcpId,
        sessionId: clientMcpSessionId,
        protocolVersion: syntheticSession.protocolVersion,
        targetUrl,
        accessToken,
        headers,
        signal: c.req.raw.signal,
      }))
      forwardedOn = upstreamSessionId
      headers.delete('Mcp-Session-Id')
      if (upstreamSessionId) headers.set('Mcp-Session-Id', upstreamSessionId)
      // A real handshake yielded to the network: revalidate before sending the
      // queued tool call. Established/stateless requests authorize only once.
      if (handshake) {
        const refreshed = await mcp.authorization()
        if (!refreshed.ok) throw new Error('MCP authorization unavailable after handshake')
        accessToken = refreshed.accessToken
        headers.delete('Authorization')
        if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
      }
    }
    const init: RequestInit = { method, headers, signal: c.req.raw.signal }
    if (bodyBuffer) init.body = bodyBuffer
    c.req.raw.signal.throwIfAborted()
    return requestUpstream(() => mcpSafeFetch(targetUrl, init))
  }

  try {
    const authorization = await prepareAuthorization()
    if (authorization instanceof Response) return authorization
    let response = await forwardRequest(authorization)

    // A live server can discover token revocation only when it handles the
    // request. Hold the original call, reconnect, then retry it exactly once.
    if (response.status === 401) {
      try {
        await response.body?.cancel()
      } catch (err) {
        console.warn('[mcp-proxy] Failed to cancel unauthorized response body:', err)
      }
      await mcp.markAuthRequired('Remote server returned 401')
      // Only the binding this request used: another request may have bound a newer one since.
      if (syntheticSession && clientMcpSessionId) await actor.mcpSessions.unbind(clientMcpSessionId, forwardedOn)
      const protocolResponse = await authRequiredProtocolResponse()
      if (protocolResponse) return protocolResponse
      const reauthResult = await mcp.recoverAuthorization(c.req.raw.signal)
      if (!reauthResult.ok) return reauthFailureResponse(reauthResult)
      const refreshed = await mcp.authorization()
      if (!refreshed.ok) return reauthFailureResponse({ ok: false, reason: 'inactive' })
      response = await forwardRequest(refreshed)
    }

    if (method === 'POST' && !c.req.raw.signal.aborted) await mcp.reportHealth(response.status < 500).catch(() => {})
    const durationMs = Date.now() - startTime

    if (shouldRewriteNonSseGet(method, response)) {
      const upstreamType = response.headers.get('content-type') ?? 'missing'
      try {
        await response.body?.cancel()
      } catch (err) {
        console.warn('[mcp-proxy] Failed to cancel non-SSE GET body:', err)
      }
      await logMcpAuditEntry({
        agentSlug,
        remoteMcpId: mcp.descriptor.id,
        remoteMcpName: mcp.descriptor.name,
        method,
        requestPath: mcpMethodInfo,
        statusCode: 405,
        errorMessage: `rewrote non-SSE GET 200 (${upstreamType}) to 405`,
        durationMs,
        policyDecision: resolvedPolicyDecision,
        ...ruleAudit,
        matchedTool: toolName ?? undefined,
      })
      return new Response(null, {
        status: 405,
        headers: { Allow: 'POST' },
      })
    }

    // Audit before returning the upstream response.
    await logMcpAuditEntry({
      agentSlug,
      remoteMcpId: mcp.descriptor.id,
      remoteMcpName: mcp.descriptor.name,
      method,
      requestPath: mcpMethodInfo,
      statusCode: response.status,
      durationMs,
      policyDecision: resolvedPolicyDecision,
      ...ruleAudit,
      matchedTool: toolName ?? undefined,
    })

    // A failed retry stays marked, but is returned rather than opening an
    // unbounded second reconnect loop for the same proxy request.
    if (response.status === 401) {
      background(mcp.markAuthRequired('Remote server returned 401').catch(() => {}), { name: 'mcp-proxy-route.mark-auth-required' })
    }

    if (method === 'DELETE' && clientMcpSessionId && syntheticSession) {
      await actor.mcpSessions.close(clientMcpSessionId)
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
      await mcp.markAuthRequired('MCP session re-initialization returned 401')
    }
    await logMcpAuditEntry({
      agentSlug,
      remoteMcpId: mcp.descriptor.id,
      remoteMcpName: mcp.descriptor.name,
      method,
      requestPath: mcpMethodInfo,
      errorMessage: `Proxy request failed: ${error}`,
      durationMs,
      policyDecision: resolvedPolicyDecision,
      ...ruleAudit,
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

import { Hono } from 'hono'
import crypto from 'crypto'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { resolveMcpPolicy } from '@shared/lib/proxy/policy-resolver'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import {
  getAutopilotAuthorization,
  isAutopilotAuthorizationCurrent,
} from '@shared/lib/autopilot/autopilot-status'
import { reviewAutopilotApproval } from '@shared/lib/autopilot/autopilot-approval-reviewer'
import { autopilotApprovalDeniedMessage } from '@shared/lib/autopilot/autopilot-service'
import { db } from '@shared/lib/db'
import {
  remoteMcpServers,
  agentRemoteMcps,
  mcpAuditLog,
} from '@shared/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { mcpSafeFetch } from '@shared/lib/mcp/mcp-safe-fetch'

/**
 * The most text (JSON-RPC request body, and separately the forwarded-header
 * block) the autopilot approval judge will inspect. The judge must see each
 * COMPLETELY or not at all — anything larger is unreviewable and fails closed.
 * Generous enough for real tool calls; a payload past it is almost certainly
 * bulk content, not scoping information.
 */
export const REVIEWABLE_BODY_CHAR_CAP = 16_000

/**
 * Request headers NOT forwarded to the MCP server (hop-by-hop + credentials —
 * the real Authorization is injected after filtering). The autopilot approval
 * review shows the judge exactly the headers that survive this filter, so the
 * forward path and the review must share this one set.
 */
const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
])

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
  decisionReason?: string
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
      decisionReason: entry.decisionReason ?? null,
      createdAt: new Date(),
    })
  } catch (error) {
    console.error('[mcp-proxy] Failed to write audit log:', error)
  }
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

    return data.access_token
  } catch {
    return null
  }
}

const mcpProxy = new Hono()

// Catch-all route: /api/mcp-proxy/:agentSlug/:mcpId and optional trailing path
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
  const mappings = await db
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

  if (mappings.length === 0) {
    return c.json({ error: 'MCP server not found or not assigned to this agent' }, 404)
  }

  const mcp = mappings[0].mcp
  const method = c.req.method

  // 2.5 Parse JSON-RPC body early for policy enforcement and audit logging.
  // `canonicalRequest` records whether the body is exactly one well-formed
  // JSON-RPC object — the autopilot approval review refuses anything else
  // (a batch array or a body our parser can't read could otherwise carry
  // tool calls the judge never saw).
  let bodyBuffer: ArrayBuffer | undefined
  let mcpMethodInfo = rest || '/'
  let toolName: string | null = null
  let requestBodyText: string | undefined
  let canonicalRequest = false
  if (method !== 'GET' && method !== 'HEAD') {
    bodyBuffer = await c.req.arrayBuffer()
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bodyBuffer)
      const jsonRpc = JSON.parse(text) as {
        method?: unknown
        params?: { name?: unknown }
      }
      if (
        jsonRpc !== null &&
        typeof jsonRpc === 'object' &&
        !Array.isArray(jsonRpc) &&
        typeof jsonRpc.method === 'string'
      ) {
        canonicalRequest = true
        requestBodyText = text
        mcpMethodInfo = jsonRpc.method
        if (jsonRpc.method === 'tools/call' && typeof jsonRpc.params?.name === 'string') {
          toolName = jsonRpc.params.name
          mcpMethodInfo = `tools/call: ${toolName}`
        }
      }
    } catch {
      // Not UTF-8 JSON — keep the HTTP path (and fail the canonical check)
    }
  }

  // 2.55 Build target URL (needed by the autopilot review below, which must
  // judge the request's real destination including the query string).
  // The MCP server URL is the base; append the rest path if any.
  const baseUrl = mcp.url.replace(/\/$/, '')
  const targetPath = rest ? `/${rest}` : ''
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const queryString = new URL(c.req.url).search
  const targetUrl = `${baseUrl}${targetPath}${queryString}`

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
  // Reason recorded alongside autopilot reviewer decisions; rides the final
  // audit entry for approvals.
  let autopilotDecisionReason: string | undefined

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
      // Autopilot: instead of parking a review card the user is not there to
      // answer, an automated reviewer decides on their behalf — it sees ONLY
      // the user's own messages plus this request (never the agent
      // trajectory). See the API proxy's mirror branch.
      const autopilotAuthorization = await getAutopilotAuthorization(agentSlug)
      if (autopilotAuthorization) {
        // The judge must see the request EXACTLY as it will be forwarded: one
        // canonical JSON-RPC request (batched, malformed, or non-UTF-8 bodies
        // could carry tool calls the judge never saw — refused outright), the
        // real target URL including the query string, the complete forwarded
        // header set (same skip-set as the forward at step 5; Authorization is
        // stripped, so the judge never sees credentials), and the complete
        // body. Anything too large to inspect in full fails closed.
        let unreviewable: string | undefined
        if (bodyBuffer && bodyBuffer.byteLength > 0 && !canonicalRequest) {
          unreviewable =
            'Request body is not a single well-formed JSON-RPC request (batched, malformed, or non-UTF-8), so it cannot be inspected in full. Denied by default.'
        } else if (requestBodyText && requestBodyText.length > REVIEWABLE_BODY_CHAR_CAP) {
          unreviewable = `Request body is ${requestBodyText.length} characters — beyond the ${REVIEWABLE_BODY_CHAR_CAP}-character automated-review limit, so it cannot be inspected in full. Denied by default.`
        }
        const headerLines: string[] = []
        c.req.raw.headers.forEach((value, key) => {
          if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) {
            headerLines.push(`${key}: ${value}`)
          }
        })
        const headersBlock = headerLines.join('\n')
        if (!unreviewable && headersBlock.length > REVIEWABLE_BODY_CHAR_CAP) {
          unreviewable = `Forwarded request headers total ${headersBlock.length} characters — beyond the ${REVIEWABLE_BODY_CHAR_CAP}-character automated-review limit, so the request cannot be inspected in full. Denied by default.`
        }
        let review = unreviewable
          ? { decision: 'deny' as const, reason: unreviewable }
          : await reviewAutopilotApproval({
              agentSlug,
              action: `MCP tool call: ${toolName ?? mcpMethodInfo} on server "${mcp.name}" (${method} ${targetUrl})`,
              details:
                [
                  headersBlock
                    ? `Request headers (complete, as forwarded):\n${headersBlock}`
                    : undefined,
                  requestBodyText
                    ? `JSON-RPC request body (complete): ${requestBodyText}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join('\n') || undefined,
            })
        // An approval only stands while the authorization it was judged under
        // does. The user can switch autopilot off, or interrupt (opening a
        // new era), while the model review is in flight — revalidate the
        // captured session/era set immediately before promoting the approval,
        // and drop requests the caller has already abandoned.
        if (review.decision !== 'deny') {
          if (c.req.raw.signal.aborted) {
            review = {
              decision: 'deny',
              reason: 'The request was cancelled while automated review was in flight.',
            }
          } else if (!(await isAutopilotAuthorizationCurrent(agentSlug, autopilotAuthorization))) {
            review = {
              decision: 'deny',
              reason:
                'Autopilot was switched off or interrupted while automated review was in flight, so the approval no longer applies.',
            }
          }
        }
        if (review.decision === 'deny') {
          await logMcpAuditEntry({
            agentSlug,
            remoteMcpId: mcp.id,
            remoteMcpName: mcp.name,
            method,
            requestPath: mcpMethodInfo,
            policyDecision: 'denied_autopilot',
            matchedTool: toolName ?? undefined,
            decisionReason: review.reason,
          })
          return c.json(
            {
              error: 'requires_user_approval',
              message: `${autopilotApprovalDeniedMessage('This MCP tool call')} Reviewer: ${review.reason}`,
              tool: toolName,
            },
            403
          )
        }
        resolvedPolicyDecision = 'approved_autopilot'
        autopilotDecisionReason = review.reason
      } else {
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
        await db
          .update(remoteMcpServers)
          .set({
            status: 'auth_required',
            errorMessage: 'Token refresh failed',
            updatedAt: new Date(),
          })
          .where(eq(remoteMcpServers.id, mcp.id))

        await logMcpAuditEntry({
          agentSlug,
          remoteMcpId: mcp.id,
          remoteMcpName: mcp.name,
          method: c.req.method,
          requestPath: rest,
          errorMessage: 'Token refresh failed',
          policyDecision: resolvedPolicyDecision,
          matchedTool: toolName ?? undefined,
          decisionReason: autopilotDecisionReason,
        })

        return c.json({ error: 'MCP server requires re-authentication' }, 401)
      }
    }

    if (!accessToken) {
      return c.json({ error: 'MCP server has no access token configured' }, 401)
    }
  }

  // 4. Forward request (target URL built at step 2.55)
  const forwardHeaders = new Headers()
  c.req.raw.headers.forEach((value, key) => {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value)
    }
  })

  // Add real auth header
  if (accessToken) {
    forwardHeaders.set('Authorization', `Bearer ${accessToken}`)
  }

  const init: RequestInit = { method, headers: forwardHeaders }
  if (bodyBuffer) {
    init.body = bodyBuffer
  }

  try {
    const response = await mcpSafeFetch(targetUrl, init)
    const durationMs = Date.now() - startTime

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
      decisionReason: autopilotDecisionReason,
    })

    // If 401, mark MCP as auth_required
    if (response.status === 401) {
      db.update(remoteMcpServers)
        .set({
          status: 'auth_required',
          errorMessage: 'Remote server returned 401',
          updatedAt: new Date(),
        })
        .where(eq(remoteMcpServers.id, mcp.id))
        .catch(() => {})
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
      decisionReason: autopilotDecisionReason,
    })
    return c.json(
      { error: 'MCP proxy request failed', details: String(error) },
      502
    )
  }
})

export default mcpProxy

import { Hono } from 'hono'
import crypto from 'crypto'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { resolveMcpPolicy } from '@shared/lib/proxy/policy-resolver'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import { isAgentAutopilotEngaged } from '@shared/lib/autopilot/autopilot-status'
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
 * The most tool-call argument text the autopilot approval judge will inspect.
 * The judge must see arguments COMPLETELY or not at all — anything larger is
 * unreviewable and fails closed. Generous enough for real tool calls; a
 * payload past it is almost certainly bulk content, not scoping information.
 */
export const REVIEWABLE_ARGS_CHAR_CAP = 16_000

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

  // 2.5 Parse JSON-RPC body early for policy enforcement and audit logging
  let bodyBuffer: ArrayBuffer | undefined
  let mcpMethodInfo = rest || '/'
  let toolName: string | null = null
  let toolArgs: string | undefined
  let toolArgsTooLarge = false
  if (method !== 'GET' && method !== 'HEAD') {
    bodyBuffer = await c.req.arrayBuffer()
    try {
      const text = new TextDecoder().decode(bodyBuffer)
      const jsonRpc = JSON.parse(text) as {
        method?: string
        params?: { name?: string; arguments?: unknown }
      }
      if (jsonRpc.method) {
        mcpMethodInfo = jsonRpc.method
        if (jsonRpc.method === 'tools/call' && jsonRpc.params?.name) {
          toolName = jsonRpc.params.name
          mcpMethodInfo = `tools/call: ${toolName}`
          if (jsonRpc.params.arguments !== undefined) {
            // For the autopilot approval reviewer: the args ARE the action
            // being judged, so the judge must see them COMPLETELY — a
            // truncated view lets a destination or destructive flag hide past
            // the cutoff. Args too large to represent losslessly make the
            // call unreviewable (the reviewer fails closed on that flag).
            const serialized = JSON.stringify(jsonRpc.params.arguments)
            if (serialized.length > REVIEWABLE_ARGS_CHAR_CAP) {
              toolArgsTooLarge = true
            } else {
              toolArgs = serialized
            }
          }
        }
      }
    } catch {
      // Not JSON or not JSON-RPC — keep the HTTP path
    }
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
      if (await isAgentAutopilotEngaged(agentSlug)) {
        // Fail closed when the arguments cannot be shown to the judge in
        // full — an approval based on a partial view is no approval.
        const review = toolArgsTooLarge
          ? {
              decision: 'deny' as const,
              reason: `Tool arguments exceed the ${REVIEWABLE_ARGS_CHAR_CAP}-character automated-review limit and cannot be inspected in full. Denied by default.`,
            }
          : await reviewAutopilotApproval({
              agentSlug,
              action: `MCP tool call: ${toolName ?? mcpMethodInfo} on server "${mcp.name}"`,
              details: toolArgs ? `Arguments (complete): ${toolArgs}` : undefined,
            })
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

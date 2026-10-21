import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import { agentRemoteMcps, remoteMcpServers, type RemoteMcpServer } from '../db/schema'
import { agentRegistry } from '../agent-actor'
import { resumeMcpReauthWaits } from '../services/connection-sync-service'
import { resolveMcpPolicy } from '../proxy/policy-resolver'
import { awaitReauth } from '../proxy/reauth-request'
import { mcpSafeFetch } from './mcp-safe-fetch'
import { mcpRefreshResponseSchema, parseCachedMcpTools } from './connection-schema'
import type { McpToolInfo } from './types'
import type { McpAccessResult, McpAuthorization, McpConnection, McpInvocation, McpRecoveryResult } from './connection-types'
import { auditRuleOutcomes, decidingRuleVersionId, evaluateRulesForRequest, reportedRules, reviewRuleOutcomes } from '../proxy/rules/gate'
import { buildMcpRuleInput } from '../proxy/rules/input'
import { awaitReview } from '@shared/lib/proxy/review-request'

async function loadAssignedMcp(agentSlug: string, mcpId: string): Promise<RemoteMcpServer | null> {
  const [mapping] = await db.select({ mcp: remoteMcpServers }).from(agentRemoteMcps)
    .innerJoin(remoteMcpServers, eq(agentRemoteMcps.remoteMcpId, remoteMcpServers.id))
    .where(and(eq(agentRemoteMcps.agentSlug, agentSlug), eq(agentRemoteMcps.remoteMcpId, mcpId)))
    .limit(1)
  return mapping?.mcp ?? null
}

export async function resolveAccountMcpConnection(agentSlug: string, mcpId: string): Promise<McpConnection | null> {
  const row = await loadAssignedMcp(agentSlug, mcpId)
  return row ? new AccountMcpConnection(agentSlug, row) : null
}

class AccountMcpConnection implements McpConnection {
  private credential: McpAuthorization | undefined
  private tools: McpToolInfo[]

  constructor(private readonly agentSlug: string, private row: RemoteMcpServer) {
    this.tools = parseCachedMcpTools(row.toolsJson)
  }

  get descriptor() {
    return { id: this.row.id, name: this.row.name, url: this.row.url, status: this.row.status,
      tools: this.tools }
  }

  async authorizeInvocation(call: McpInvocation): Promise<McpAccessResult> {
    if (call.isProtocolMethod) return { ok: true, policyDecision: 'allow' }
    const resolvePolicy = async () => {
      try {
        return await resolveMcpPolicy(this.row.id, call.toolName, this.row.userId ?? 'local')
      } catch (error) {
        console.error('[mcp-proxy] Policy enforcement failed, defaulting to review:', error)
        return { decision: 'review' as const, matchedScopes: [] as string[], scopeDescriptions: {} as Record<string, string> }
      }
    }
    const policy = await resolvePolicy()
    if (policy.decision === 'block') return { ok: false, reason: 'blocked' }
    const policyOutcome = policy.decision === 'review' ? 'review' : 'allow'

    // Proxy rules: a require rule can send an allowed call to review; an
    // allow rule can move a reviewed call to allow.
    const toolName = call.toolName
    const runRules = (outcome: 'allow' | 'review') => toolName
      ? evaluateRulesForRequest({ kind: 'mcp', targetId: this.row.id }, this.agentSlug, outcome,
        { kind: 'mcp', tool: toolName }, () => buildMcpRuleInput({ tool: toolName, args: call.args }))
      : Promise.resolve(null)
    const gate = await runRules(policyOutcome)
    const ruleOutcomes = gate ? auditRuleOutcomes(gate.evaluations) : undefined
    const ruleVersionId = decidingRuleVersionId(gate)
    // No one can tell whether a require rule would hold this call: answer now
    // so the agent can retry, rather than parking an allowed call for minutes.
    if (gate?.unavailable && policyOutcome === 'allow') return { ok: false, reason: 'rules_unavailable' }
    if (gate?.allowedBy) return { ok: true, policyDecision: 'allowed_by_rule', ruleVersionId, ruleOutcomes }
    if ((gate?.decision ?? policyOutcome) === 'allow') return { ok: true, policyDecision: policy.decision, ruleOutcomes }
    const reviewOutcomes = gate ? reviewRuleOutcomes(gate.evaluations) : []
    const rules = gate ? reportedRules(gate) : []
    try {
      const reviews = agentRegistry.get(this.agentSlug).inputs.reviews
      const decision = await awaitReview(reviews, (raise) => reviews.request({
        accountId: this.row.id, reviewType: 'mcp', toolkit: this.row.name, method: call.method,
        targetPath: call.requestPath, matchedScopes: policy.matchedScopes,
        scopeDescriptions: policy.scopeDescriptions,
        ...(reviewOutcomes.length > 0 ? { ruleOutcomes: reviewOutcomes } : {}),
      }, raise), {
        signal: call.signal,
        // When an "always" decision on another card changes the policy, this
        // call is decided again rather than released.
        reevaluate: async () => {
          const current = await resolvePolicy()
          if (current.decision === 'block') return 'deny'
          const outcome = current.decision === 'review' ? 'review' : 'allow'
          const again = await runRules(outcome)
          if (!again) return outcome
          return again.unavailable ? 'review' : again.decision
        },
      })
      return decision === 'deny'
        ? { ok: false, reason: 'denied', rules, ruleVersionId, ruleOutcomes }
        : { ok: true, policyDecision: 'approved_by_user', ruleVersionId, ruleOutcomes }
    } catch { return { ok: false, reason: 'review_timeout', rules, ruleVersionId, ruleOutcomes } }
  }

  async authorization(): Promise<McpAuthorization> {
    if (this.credential) return this.credential
    let accessToken = this.row.accessToken
    if (this.row.authType !== 'none') {
      if (this.row.tokenExpiresAt && this.row.tokenExpiresAt.getTime() < Date.now() && this.row.refreshToken) {
        accessToken = await tryRefreshToken(this.row)
        if (!accessToken) {
          await this.markAuthRequired('Token refresh failed')
          return { ok: false }
        }
      }
      if (!accessToken) {
        await this.markAuthRequired('MCP server has no access token configured')
        return { ok: false }
      }
    }
    return this.credential = { ok: true, accessToken }
  }

  async markAuthRequired(message: string): Promise<void> {
    this.credential = undefined
    await db.update(remoteMcpServers).set({ status: 'auth_required', errorMessage: message, updatedAt: new Date() })
      .where(eq(remoteMcpServers.id, this.row.id))
    this.row = { ...this.row, status: 'auth_required' }
  }

  async recoverAuthorization(signal: AbortSignal): Promise<McpRecoveryResult> {
    const wait = await awaitReauth(agentRegistry.get(this.agentSlug).inputs.mcpReauth, {
      mcpId: this.row.id, mcpName: this.row.name, authType: this.row.authType,
    }, signal)
    if (wait.outcome === 'replaced') return { ok: false, reason: 'replaced', replacementMcpId: wait.replacementId }
    if (wait.outcome === 'dismissed') return { ok: false, reason: 'dismissed', dismissReason: wait.reason }
    if (wait.outcome !== 'resumed') return { ok: false, reason: 'timeout' }
    const refreshed = await loadAssignedMcp(this.agentSlug, this.row.id)
    if (!refreshed) return { ok: false, reason: 'missing' }
    if (refreshed.status !== 'active') return { ok: false, reason: 'inactive' }
    this.row = refreshed
    this.tools = parseCachedMcpTools(refreshed.toolsJson)
    this.credential = undefined
    return { ok: true }
  }

  async reportHealth(_available: boolean): Promise<void> { /* Account MCPs have no availability monitor. */ }
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

    const data = mcpRefreshResponseSchema.parse(await res.json())

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

    await resumeMcpReauthWaits(mcp.id)

    return data.access_token
  } catch {
    return null
  }
}

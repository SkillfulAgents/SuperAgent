/**
 * The proxies' entry point into rules: load the live rules for a request's
 * target and agent, evaluate them, and shape the results for the audit log,
 * the review card and the denial response.
 */
import { remoteMcpServers } from '@shared/lib/db/schema'
import { db } from '@shared/lib/db'
import { eq } from 'drizzle-orm'
import { parseCachedMcpTools } from '@shared/lib/mcp/connection-schema'
import type { McpToolInfo } from '@shared/lib/mcp/types'
import {
  evaluateRules,
  relevantRules,
  toolSchemaHash,
  type ActiveRule,
  type PolicyOutcome,
  type RuleEffect,
  type RuleEvaluation,
  type RuleMatch,
  type RulesResult,
} from './engine'
import { listActiveRules, type RuleTarget } from './store'
import type { RuleInput } from './input'

export interface GateResult extends RulesResult {
  rules: ActiveRule[]
  /**
   * The rules could not be loaded or run. The request goes to review; when
   * the policy allowed it, the proxies answer at once instead, since no one
   * can tell whether a require rule would have held it.
   */
  unavailable?: boolean
}

/** A rule as reported to the agent when its request was not allowed: which
 * rule and what it decided, never its code or patterns. */
export interface ReportedRule {
  id: string
  version: number
  effect: RuleEffect
  name: string
  result: string
}

/** A rule outcome as shown on the review card (a type alias so it fits the
 * review payload's loose-object schema). */
export type ReviewRuleOutcome = {
  ruleId: string
  version: number
  effect: RuleEffect
  name: string
  restatement: string
  result: string
  detail?: string
}

const LOAD_RETRY_DELAY_MS = 50

async function loadRules(target: RuleTarget, agentSlug: string): Promise<ActiveRule[]> {
  try {
    return await listActiveRules(target, agentSlug)
  } catch (error) {
    console.warn('[proxy-rules] Loading rules failed, retrying once:', error)
    await new Promise((resolve) => setTimeout(resolve, LOAD_RETRY_DELAY_MS))
    return listActiveRules(target, agentSlug)
  }
}

// Parsed tool lists and per-pattern schema hashes, per MCP server, reused
// until the server's cached tool list changes.
const toolHashCache = new Map<string, { toolsJson: string | null; tools: McpToolInfo[]; hashes: Map<string, string> }>()

async function schemaHasher(mcpId: string): Promise<(patterns: string[]) => string> {
  const [server] = await db.select({ toolsJson: remoteMcpServers.toolsJson })
    .from(remoteMcpServers).where(eq(remoteMcpServers.id, mcpId)).limit(1)
  const toolsJson = server?.toolsJson ?? null
  let entry = toolHashCache.get(mcpId)
  if (!entry || entry.toolsJson !== toolsJson) {
    entry = { toolsJson, tools: parseCachedMcpTools(toolsJson), hashes: new Map() }
    if (toolHashCache.size > 200) toolHashCache.clear()
    toolHashCache.set(mcpId, entry)
  }
  const { tools, hashes } = entry
  return (patterns) => {
    const key = JSON.stringify(patterns)
    let hash = hashes.get(key)
    if (hash === undefined) {
      hash = toolSchemaHash(patterns, tools)
      hashes.set(key, hash)
    }
    return hash
  }
}

/**
 * Evaluate rules for a request the policy allowed or sent to review. The
 * request is only built (and its body read) when a rule's patterns match.
 * Never throws: a failure to load or run rules sends the request to review
 * and marks the result `unavailable`.
 */
export async function evaluateRulesForRequest(
  target: RuleTarget,
  agentSlug: string,
  policy: PolicyOutcome,
  match: RuleMatch,
  buildInput: () => RuleInput | Promise<RuleInput>,
): Promise<GateResult> {
  try {
    const rules = relevantRules(await loadRules(target, agentSlug), match, policy)
    if (rules.length === 0) return { rules, decision: policy, allowedBy: null, heldBy: null, evaluations: [] }
    const input = await buildInput()
    const currentToolSchemaHash = target.kind === 'mcp' && rules.some((r) => r.toolSchemaHash)
      ? await schemaHasher(target.targetId)
      : undefined
    return { rules, ...await evaluateRules(rules, input, policy, { currentToolSchemaHash }) }
  } catch (error) {
    console.error('[proxy-rules] Rule evaluation failed, sending request to review:', error)
    return { rules: [], decision: 'review', allowedBy: null, heldBy: null, evaluations: [], unavailable: true }
  }
}

/** The rule version that decided the request, for the audit row. */
export function decidingRuleVersionId(gate: GateResult | null): string | undefined {
  return gate?.allowedBy?.versionId ?? gate?.heldBy?.versionId
}

/**
 * What the audit row keeps per rule that ran. Name and description are not
 * copied: the version id recovers them, and versions are immutable.
 */
export function auditRuleOutcomes(evaluations: RuleEvaluation[]): string | undefined {
  if (evaluations.length === 0) return undefined
  return JSON.stringify(evaluations.map((e) => ({
    ruleId: e.ruleId,
    versionId: e.versionId,
    version: e.version,
    effect: e.effect,
    result: e.outcome.result,
    ...('detail' in e.outcome && e.outcome.detail ? { detail: e.outcome.detail.slice(0, 200) } : {}),
    durationMs: e.durationMs,
  })))
}

export function reviewRuleOutcomes(evaluations: RuleEvaluation[]): ReviewRuleOutcome[] {
  return evaluations.map((e) => ({
    ruleId: e.ruleId,
    version: e.version,
    effect: e.effect,
    name: e.name,
    restatement: e.restatement,
    result: e.outcome.result,
    ...('detail' in e.outcome && e.outcome.detail ? { detail: e.outcome.detail } : {}),
  }))
}

/** Every rule that ran and did not answer "fine without review", by name. */
export function reportedRules(gate: GateResult): ReportedRule[] {
  return gate.evaluations.flatMap((e) => (e.outcome.result === 'true' ? [] : [{
    id: e.ruleId,
    version: e.version,
    effect: e.effect,
    name: e.name,
    result: e.outcome.result,
  }]))
}

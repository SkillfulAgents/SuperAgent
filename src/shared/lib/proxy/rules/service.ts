/**
 * Shared steps for saving a rule, whoever wrote it: load the target's context,
 * validate the draft, and restate it from its code.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import {
  agentConnectedAccounts,
  agentRemoteMcps,
  connectedAccounts,
  remoteMcpServers,
} from '@shared/lib/db/schema'
import { parseCachedMcpTools } from '@shared/lib/mcp/connection-schema'
import type { McpToolInfo } from '@shared/lib/mcp/types'
import { SCOPE_MAPS } from '../scope-maps'
import { matchScopes } from '../scope-matcher'
import { resolveApiPolicy, resolveMcpPolicy } from '../policy-resolver'
import { validateRuleDraft, type RuleDraft, type RuleDraftReport, type RuleKind } from './engine'
import { catalogFor, restateRule } from './author'
import type { RuleTarget } from './store'

export interface TargetContext {
  target: RuleTarget
  /** Account display name or MCP server name. */
  name: string
  /** Toolkit slug (api only). */
  toolkit?: string
  tools?: McpToolInfo[]
  userId: string | null
}

/**
 * The policy each catalog entry resolves to today, keyed "METHOD /path" (api)
 * or tool name (mcp) — what the author needs to pick a rule's effect.
 */
export async function catalogPolicies(context: TargetContext): Promise<Record<string, string>> {
  const userId = context.userId ?? 'local'
  const policies: Record<string, string> = {}
  if (context.target.kind === 'api') {
    const map = context.toolkit ? SCOPE_MAPS[context.toolkit] : undefined
    for (const entry of map?.scopeMap ?? []) {
      const path = entry.pathPattern.replace(/\*+/g, 'x')
      const match = matchScopes(context.toolkit!, entry.method, path, map!.apiHost)
      policies[`${entry.method} ${entry.pathPattern}`] = (await resolveApiPolicy(context.target.targetId, match, userId, context.toolkit)).decision
    }
  } else {
    for (const tool of context.tools ?? []) {
      policies[tool.name] = (await resolveMcpPolicy(context.target.targetId, tool.name, userId)).decision
    }
  }
  return policies
}

export async function loadTargetContext(target: RuleTarget): Promise<TargetContext | null> {
  if (target.kind === 'api') {
    const [account] = await db.select().from(connectedAccounts)
      .where(eq(connectedAccounts.id, target.targetId)).limit(1)
    if (!account) return null
    return { target, name: account.displayName, toolkit: account.toolkitSlug, userId: account.userId }
  }
  const [server] = await db.select().from(remoteMcpServers)
    .where(eq(remoteMcpServers.id, target.targetId)).limit(1)
  if (!server) return null
  return { target, name: server.name, tools: parseCachedMcpTools(server.toolsJson), userId: server.userId }
}

/** Whether the agent is mapped to the account / MCP server. */
export async function agentCanUseTarget(agentSlug: string, target: RuleTarget): Promise<boolean> {
  if (target.kind === 'api') {
    const [row] = await db.select({ id: agentConnectedAccounts.id }).from(agentConnectedAccounts)
      .where(and(eq(agentConnectedAccounts.agentSlug, agentSlug), eq(agentConnectedAccounts.connectedAccountId, target.targetId)))
      .limit(1)
    return !!row
  }
  const [row] = await db.select({ id: agentRemoteMcps.id }).from(agentRemoteMcps)
    .where(and(eq(agentRemoteMcps.agentSlug, agentSlug), eq(agentRemoteMcps.remoteMcpId, target.targetId)))
    .limit(1)
  return !!row
}

export interface PreparedDraft {
  draft: RuleDraft
  report: RuleDraftReport
  /** Short label; the description, shortened, when no restatement came back. */
  name: string
  /** Empty when the restatement could not be generated (see warnings). */
  restatement: string
}

export function fallbackRuleName(description: string): string {
  const text = description.trim().replace(/\s+/g, ' ')
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text
}

/** Validate a draft and, when it passes, restate it from its code. */
export async function prepareDraft(context: TargetContext, draft: RuleDraft): Promise<PreparedDraft> {
  const report = await validateRuleDraft(draft, { toolkit: context.toolkit, tools: context.tools })
  if (!report.ok) return { draft, report, name: fallbackRuleName(draft.description), restatement: '' }
  let name = fallbackRuleName(draft.description)
  let restatement = ''
  try {
    const catalog = draft.effect === 'require'
      ? catalogFor({ kind: draft.kind, toolkit: context.toolkit, tools: context.tools }, { schemas: false })
      : undefined
    const restated = await restateRule(draft, catalog)
    name = restated.name
    restatement = restated.restatement
  } catch (error) {
    console.warn('[proxy-rules] Restatement failed:', error)
    report.warnings.push('An independent description of this rule could not be generated; read the code before approving.')
  }
  return { draft, report, name, restatement }
}

export function coverageLabels(report: RuleDraftReport): string[] {
  return report.coverage.map((c) => (typeof c === 'string' ? c : `${c.method} ${c.path}${c.label ? ` (${c.label})` : ''}`))
}

export function isRuleKind(value: unknown): value is RuleKind {
  return value === 'api' || value === 'mcp'
}

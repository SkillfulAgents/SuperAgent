/**
 * Steps for saving a rule an agent proposed: load the target's context,
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
      ? catalogFor({ kind: draft.kind, toolkit: context.toolkit, tools: context.tools })
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

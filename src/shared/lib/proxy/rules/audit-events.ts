/**
 * Audit-log entries for proxy rules. Every entry is keyed by the connection
 * (account or MCP server id), like the scope-policy entries, and carries the
 * rule's id, name, effect and version so a reader can follow one rule
 * through its life: created / updated / deleted, and approved / rejected for
 * what an agent asked for.
 */
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import type { RuleProposalReview } from './proposal-schema'
import { listAgentScopedRules, listRules, toRuleView, type RuleTarget, type RuleView } from './store'

type RuleChange = 'created' | 'updated' | 'deleted'

/** Who made the change: a person in the app, an agent (with approval), or the
 * app itself (the rule went with its agent or connection). */
type RuleActor = { by: 'user' } | { by: 'agent'; agentSlug: string } | { by: 'system'; reason: string }

function ruleDetails(rule: RuleView): Record<string, unknown> {
  return {
    ruleId: rule.id,
    name: rule.name,
    effect: rule.effect,
    version: rule.version,
    versionId: rule.versionId,
    kind: rule.kind,
    appliesTo: rule.agentSlug === null ? 'all_agents' : 'agent',
    ...(rule.agentSlug !== null ? { ruleAgentSlug: rule.agentSlug } : {}),
  }
}

export async function auditRuleChange(action: RuleChange, rule: RuleView, actor: RuleActor, userId: string | null = null): Promise<void> {
  await logAuditEvent({
    userId,
    object: 'proxy_rule',
    objectId: rule.targetId,
    action,
    details: { ...ruleDetails(rule), ...actor },
  })
}

/**
 * A person's (or the clock's) answer to an agent's rule request. `via` says
 * where it was given; `userId` is who gave it, when the app knows.
 */
export async function auditRuleDecision(options: {
  proposal: RuleProposalReview
  approved: boolean
  agentSlug: string
  via: 'app' | 'chat' | 'timeout'
  userId?: string | null
  extra?: Record<string, unknown>
}): Promise<void> {
  const { proposal } = options
  const request = proposal.deletesRuleId ? 'delete' : proposal.replacesRuleId ? 'replace' : 'create'
  await logAuditEvent({
    userId: options.userId ?? null,
    object: 'proxy_rule',
    objectId: proposal.targetId,
    action: options.approved ? 'approved' : 'rejected',
    details: {
      request,
      ...(proposal.deletesRuleId || proposal.replacesRuleId ? { ruleId: proposal.deletesRuleId ?? proposal.replacesRuleId } : {}),
      name: proposal.name ?? null,
      effect: proposal.effect,
      kind: proposal.ruleKind,
      appliesTo: proposal.appliesTo,
      agentSlug: options.agentSlug,
      via: options.via,
      ...options.extra,
    },
  })
}

/**
 * The live rules that are about to go with their connection or agent, read
 * before the delete so they can be audited after it. Best effort: a failure
 * here must never stop the deletion itself.
 */
export async function rulesAboutToBeRemoved(scope: RuleTarget | { agentSlug: string }): Promise<RuleView[]> {
  try {
    const rows = 'agentSlug' in scope ? await listAgentScopedRules(scope.agentSlug) : await listRules(scope)
    return rows.map(toRuleView)
  } catch (error) {
    console.warn('[proxy-rules] Could not list rules to audit before a delete:', error)
    return []
  }
}

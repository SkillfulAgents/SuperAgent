import { and, asc, inArray } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentAcl, xAgentPolicies } from '@shared/lib/db/schema'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import type { AgentMemberAgent, AgentMemberAgentsByAgent } from '@shared/lib/types/inbound-x-agent-schema'
import { displaySlug } from '@shared/lib/utils/file-storage'
import { listAgents } from './agent-service'
import { callerEligibility, type AgentAclRow } from './inbound-x-agent-service'
import type { XAgentDecision } from './x-agent-policy-service'

interface MemberAgentSource {
  slug: string
  name: string
  avatar?: AgentAvatar | null
}

interface PolicyRow {
  callerAgentSlug: string
  targetAgentSlug: string | null
  operation: 'list' | 'read' | 'invoke'
  decision: XAgentDecision
}

interface BuildAgentMemberAgentsInput {
  /** The agents the viewer can see: both the ones listed and the members named. */
  agents: MemberAgentSource[]
  /** Their invoke and read policies, oldest write first, so the latest wins. */
  policies: PolicyRow[]
  authMode: boolean
  aclRows: AgentAclRow[]
}

/**
 * Which agents have a role on which, for every agent at once: what the share
 * popover's member list shows for one agent, without a request per sidebar
 * row. Pure, so the rules it shares with x-agent-policy-service's `evaluate`
 * (a target's own row, else the caller's row for every agent, else Review)
 * and with the calls page (a blocked agent is not a member; in auth mode the
 * two agents must share a person) are tested without a database.
 */
export function buildAgentMemberAgents({ agents, policies, authMode, aclRows }: BuildAgentMemberAgentsInput): AgentMemberAgentsByAgent {
  const decisions = new Map<string, XAgentDecision>()
  const key = (caller: string, operation: string, target: string | null) => `${caller}\u0000${operation}\u0000${target ?? ''}`
  for (const row of policies) decisions.set(key(row.callerAgentSlug, row.operation, row.targetAgentSlug), row.decision)
  const effective = (caller: string, operation: 'invoke' | 'read', target: string): XAgentDecision =>
    decisions.get(key(caller, operation, target)) ?? decisions.get(key(caller, operation, null)) ?? 'review'
  const sharesAnOwner = callerEligibility(aclRows)

  const byAgent: AgentMemberAgentsByAgent = {}
  for (const target of agents) {
    const members = agents.flatMap<AgentMemberAgent>((caller) => {
      if (caller.slug === target.slug) return []
      if (authMode && !sharesAnOwner(caller.slug, target.slug)) return []
      const invoke = effective(caller.slug, 'invoke', target.slug)
      if (invoke === 'block') return []
      const role = invoke === 'allow' ? 'user' : effective(caller.slug, 'read', target.slug) === 'allow' ? 'viewer' : null
      if (!role) return []
      return [{
        slug: caller.slug,
        displaySlug: displaySlug(caller.name, caller.slug),
        name: caller.name,
        avatar: caller.avatar ?? null,
        role,
      }]
    })
    if (members.length > 0) byAgent[target.slug] = members.sort((a, b) => a.name.localeCompare(b.name))
  }
  return byAgent
}

/** Member agents for the agents in `visibleSlugs`: what the viewer's agent list shows. */
export async function getAgentMemberAgents(visibleSlugs: string[], authMode: boolean): Promise<AgentMemberAgentsByAgent> {
  if (visibleSlugs.length < 2) return {}
  const visible = new Set(visibleSlugs)
  const records = await listAgents()
  const policies = await db
    .select({
      callerAgentSlug: xAgentPolicies.callerAgentSlug,
      targetAgentSlug: xAgentPolicies.targetAgentSlug,
      operation: xAgentPolicies.operation,
      decision: xAgentPolicies.decision,
    })
    .from(xAgentPolicies)
    .where(and(
      inArray(xAgentPolicies.callerAgentSlug, visibleSlugs),
      inArray(xAgentPolicies.operation, ['invoke', 'read']),
    ))
    .orderBy(asc(xAgentPolicies.updatedAt))
    .all()
  const aclRows = authMode
    ? await db
        .select({ agentSlug: agentAcl.agentSlug, userId: agentAcl.userId, role: agentAcl.role })
        .from(agentAcl)
        .where(inArray(agentAcl.agentSlug, visibleSlugs))
        .all()
    : []
  return buildAgentMemberAgents({
    agents: records.filter((record) => visible.has(record.slug)),
    policies,
    authMode,
    aclRows,
  })
}

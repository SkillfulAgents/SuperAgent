import { and, inArray } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentAcl, xAgentPolicies } from '@shared/lib/db/schema'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import { agentAccessRole, type AgentMemberAgent, type AgentMemberAgentsByAgent } from '@shared/lib/types/inbound-x-agent-schema'
import { agentCatalog } from '@shared/lib/agent-actor'
import { hasMinRole, type AgentRole } from '@shared/lib/types/agent'
import type { XAgentDecision } from './x-agent-policy-service'

interface AgentAclRow {
  agentSlug: string
  userId: string
  role: AgentRole
}

/**
 * The calls page's rule (inbound-x-agent-service): an Owner of the caller uses the target.
 * A copy of that read's owner filter: remove both together.
 */
function sharesAnOwnerWith(aclRows: AgentAclRow[]): (callerSlug: string, targetSlug: string) => boolean {
  const usersByAgent = new Map<string, Set<string>>()
  const ownersByAgent = new Map<string, string[]>()
  for (const row of aclRows) {
    if (hasMinRole(row.role, 'user')) usersByAgent.set(row.agentSlug, (usersByAgent.get(row.agentSlug) ?? new Set()).add(row.userId))
    if (row.role === 'owner') ownersByAgent.set(row.agentSlug, [...(ownersByAgent.get(row.agentSlug) ?? []), row.userId])
  }
  return (callerSlug, targetSlug) => {
    const targetUsers = usersByAgent.get(targetSlug)
    return !!targetUsers && (ownersByAgent.get(callerSlug) ?? []).some((userId) => targetUsers.has(userId))
  }
}

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
  /** Their invoke and read policies. */
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
  const sharesAnOwner = sharesAnOwnerWith(aclRows)
  // As in the share popover: a stored block either way, for either action, keeps the pair apart.
  const blockedPairs = new Set(policies.flatMap((row) => row.decision === 'block' && row.targetAgentSlug
    ? [key(row.callerAgentSlug, '', row.targetAgentSlug), key(row.targetAgentSlug, '', row.callerAgentSlug)]
    : []))

  const byAgent: AgentMemberAgentsByAgent = {}
  for (const target of agents) {
    const members = agents.flatMap<AgentMemberAgent>((caller) => {
      if (caller.slug === target.slug) return []
      if (authMode && !sharesAnOwner(caller.slug, target.slug)) return []
      if (blockedPairs.has(key(caller.slug, '', target.slug))) return []
      const invoke = effective(caller.slug, 'invoke', target.slug)
      if (invoke === 'block') return []
      const role = agentAccessRole({ decision: invoke, readDecision: effective(caller.slug, 'read', target.slug) })
      if (!role) return []
      return [{
        slug: caller.slug,
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
  const [agents, policies, aclRows] = await Promise.all([
    agentCatalog.getMany(visibleSlugs),
    db
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
      )),
    authMode
      ? db
          .select({ agentSlug: agentAcl.agentSlug, userId: agentAcl.userId, role: agentAcl.role })
          .from(agentAcl)
          .where(inArray(agentAcl.agentSlug, visibleSlugs))
      : [],
  ])
  return buildAgentMemberAgents({ agents, policies, authMode, aclRows })
}

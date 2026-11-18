import { and, inArray, isNull, or } from 'drizzle-orm'
import { agentRegistry } from '@shared/lib/agent-actor'
import { db } from '@shared/lib/db'
import { agentAcl, xAgentPolicies } from '@shared/lib/db/schema'
import type { ApiAgent } from '@shared/lib/types/api'
import type { AgentRole, SessionMetadataMap } from '@shared/lib/types/agent'
import { hasMinRole } from '@shared/lib/types/agent'
import { memberAgentsOf, type AgentMemberAgentsByAgent, type InboundXAgentBlockedAgent, type InboundXAgentCaller, type InboundXAgentDetails, type InboundXAgentSession } from '@shared/lib/types/inbound-x-agent-schema'
import { listAgentsWithStatus } from './agent-service'
import { decisionFrom, type XAgentDecision } from './x-agent-policy-service'

interface AgentAclRow {
  agentSlug: string
  userId: string
  role: string
}

interface BlockRow {
  caller: string
  target: string
  operation: 'read' | 'invoke'
}

interface BuildInboundXAgentDetailsInput {
  targetSlug: string
  metadata: SessionMetadataMap
  agents: ApiAgent[]
  authMode: boolean
  viewerUserId?: string
  viewerCanAccessAll?: boolean
  aclRows: AgentAclRow[]
  /** Stored block rows between the target and another agent, either direction. */
  blockRows?: BlockRow[]
  evaluatePolicy: (callerSlug: string, operation: 'invoke' | 'read', targetSlug: string) => XAgentDecision
}

/**
 * Build the permission-aware history payload without doing I/O. Keeping the
 * ACL/policy projection pure makes the security-sensitive visibility rules
 * straightforward to test independently of the route and database adapters.
 */
export async function buildInboundXAgentDetails({
  targetSlug,
  metadata,
  agents,
  authMode,
  viewerUserId,
  viewerCanAccessAll = false,
  aclRows,
  blockRows = [],
  evaluatePolicy,
}: BuildInboundXAgentDetailsInput): Promise<InboundXAgentDetails> {
  const agentBySlug = new Map(agents.map((agent) => [agent.slug, agent]))
  const sessions = Object.entries(metadata)
    .flatMap<InboundXAgentSession>(([id, meta]) => {
      if (!meta.createdAt) return []
      const createdAt = new Date(meta.createdAt)
      if (!Number.isFinite(createdAt.getTime())) return []
      if (meta.isWidgetRepair) {
        return [{
          id,
          createdAt: createdAt.toISOString(),
          isWidgetRepair: true,
          widgetRepairSlug: meta.widgetRepairSlug,
        }]
      }
      if (!meta.invokedByAgentSlug) return []
      const caller = agentBySlug.get(meta.invokedByAgentSlug)
      return [{
        id,
        createdAt: createdAt.toISOString(),
        triggeredBy: {
          slug: meta.invokedByAgentSlug,
          name: caller?.name ?? meta.invokedByAgentSlug,
        },
      }]
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const targetRoles = new Map(aclRows.filter((row) => row.agentSlug === targetSlug).map((row) => [row.userId, row.role as AgentRole]))
  const viewerAgents = new Set(
    aclRows
      .filter((row) => row.userId === viewerUserId)
      .map((row) => row.agentSlug),
  )
  const ownerUsersByAgent = new Map<string, Set<string>>()
  for (const row of aclRows) {
    if (row.role !== 'owner') continue
    const owners = ownerUsersByAgent.get(row.agentSlug) ?? new Set<string>()
    owners.add(row.userId)
    ownerUsersByAgent.set(row.agentSlug, owners)
  }

  const callers: InboundXAgentCaller[] = []
  const blocked: InboundXAgentBlockedAgent[] = []
  for (const agent of agents) {
    if (agent.slug === targetSlug) continue
    // As the x-agent routes check: reading needs an owner of the caller with Viewer here, messaging needs User.
    let canMessage = true
    if (authMode) {
      const ownerRoles = [...(ownerUsersByAgent.get(agent.slug) ?? [])].flatMap((userId) => targetRoles.get(userId) ?? [])
      if (!ownerRoles.some((role) => hasMinRole(role, 'viewer'))) continue
      canMessage = ownerRoles.some((role) => hasMinRole(role, 'user'))
    }

    const canAccess = !authMode || viewerCanAccessAll || viewerAgents.has(agent.slug)
    const avatar = agent.avatar ?? null
    const blocks = blockRows
      .filter((row) => row.caller === agent.slug || row.target === agent.slug)
      .map(({ caller, operation }) => ({ callerSlug: caller, operation }))
    const decision = evaluatePolicy(agent.slug, 'invoke', targetSlug)
    const readDecision = evaluatePolicy(agent.slug, 'read', targetSlug)
    if (blocks.length > 0) {
      blocked.push({ slug: agent.slug, displaySlug: agent.displaySlug, name: agent.name, avatar, canAccess, canMessage: canMessage && decision !== 'block', decision, readDecision, blocks })
    }
    // Messaging blocked for every agent still leaves a reader here: it stays listed, unable to message.
    if (decision === 'block' && readDecision !== 'allow') continue
    callers.push({
      slug: agent.slug, displaySlug: agent.displaySlug, name: agent.name, readDecision, avatar, canAccess,
      decision: decision === 'block' ? 'review' : decision,
      canMessage: canMessage && decision !== 'block',
    })
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

  return { sessions, callers: callers.sort(byName), blocked: blocked.sort(byName) }
}

export async function getInboundXAgentDetails(
  targetSlug: string,
  options: { authMode: boolean; viewerUserId?: string; viewerCanAccessAll?: boolean },
): Promise<InboundXAgentDetails> {
  const [metadata, agents, policyRows] = await Promise.all([
    agentRegistry.get(targetSlug).sessions.readMetadata(),
    listAgentsWithStatus(),
    selectPolicyRows([targetSlug]),
  ])

  const agentSlugs = agents.map((agent) => agent.slug)
  const aclRows = options.authMode && agentSlugs.length > 0
    ? await db
        .select({
          agentSlug: agentAcl.agentSlug,
          userId: agentAcl.userId,
          role: agentAcl.role,
        })
        .from(agentAcl)
        .where(inArray(agentAcl.agentSlug, agentSlugs))
    : []

  return buildInboundXAgentDetails({
    targetSlug,
    metadata,
    agents,
    authMode: options.authMode,
    viewerUserId: options.viewerUserId,
    viewerCanAccessAll: options.viewerCanAccessAll,
    aclRows,
    blockRows: blockRowsOf(policyRows),
    evaluatePolicy: decisionFrom(policyRows),
  })
}

/**
 * Every read and invoke row that can decide an agent's access to one of `slugs` or carries a block with it:
 * rows that target them, settings for every agent, and their own rows toward others. One read for the whole roster.
 */
async function selectPolicyRows(slugs: string[]) {
  return await db
    .select({
      callerAgentSlug: xAgentPolicies.callerAgentSlug,
      targetAgentSlug: xAgentPolicies.targetAgentSlug,
      operation: xAgentPolicies.operation,
      decision: xAgentPolicies.decision,
      updatedAt: xAgentPolicies.updatedAt,
    })
    .from(xAgentPolicies)
    .where(and(
      inArray(xAgentPolicies.operation, ['read', 'invoke']),
      or(isNull(xAgentPolicies.targetAgentSlug), inArray(xAgentPolicies.targetAgentSlug, slugs), inArray(xAgentPolicies.callerAgentSlug, slugs)),
    ))
}

/** The stored blocks among `rows`, for read or invoke, toward one agent. */
function blockRowsOf(rows: Awaited<ReturnType<typeof selectPolicyRows>>): BlockRow[] {
  return rows.flatMap(({ callerAgentSlug: caller, targetAgentSlug: target, operation, decision }) =>
    decision === 'block' && target && (operation === 'read' || operation === 'invoke') ? [{ caller, target, operation }] : [])
}

/**
 * The member agents of each of `targetSlugs`, by the share popover's own read run once per agent. A member
 * can be any agent, as a person in an agent's members can be anyone: everyone in an agent sees the same members.
 */
export async function buildAgentMemberAgents(
  targetSlugs: string[],
  input: Pick<BuildInboundXAgentDetailsInput, 'agents' | 'authMode' | 'aclRows' | 'evaluatePolicy'> & { blockRows: BlockRow[] },
): Promise<AgentMemberAgentsByAgent> {
  const byAgent: AgentMemberAgentsByAgent = {}
  for (const targetSlug of targetSlugs) {
    const details = await buildInboundXAgentDetails({
      ...input,
      targetSlug,
      metadata: {},
      blockRows: input.blockRows.filter((row) => row.caller === targetSlug || row.target === targetSlug),
    })
    const members = memberAgentsOf(details).map(({ slug, name, avatar, role, readDecision }) => ({ slug, name, avatar: avatar ?? null, role, readDecision }))
    if (members.length > 0) byAgent[targetSlug] = members
  }
  return byAgent
}

/** Member agents for every agent the viewer can see: one request feeds every member stack. */
export async function getAgentMemberAgents(visibleSlugs: string[], authMode: boolean): Promise<AgentMemberAgentsByAgent> {
  if (visibleSlugs.length === 0) return {}
  const policyRows = await selectPolicyRows(visibleSlugs)
  // An agent with no saved allow toward these agents asks first for everything, so it can't hold a role: only the rest are checked.
  const withAllow = [...new Set(policyRows.filter((row) => row.decision === 'allow').map((row) => row.callerAgentSlug))]
  if (withAllow.length === 0) return {}
  const [agents, aclRows] = await Promise.all([
    listAgentsWithStatus({ slugs: withAllow }),
    authMode
      ? db.select({ agentSlug: agentAcl.agentSlug, userId: agentAcl.userId, role: agentAcl.role }).from(agentAcl).where(inArray(agentAcl.agentSlug, [...visibleSlugs, ...withAllow]))
      : [],
  ])
  return buildAgentMemberAgents(visibleSlugs, { agents, authMode, aclRows, blockRows: blockRowsOf(policyRows), evaluatePolicy: decisionFrom(policyRows) })
}

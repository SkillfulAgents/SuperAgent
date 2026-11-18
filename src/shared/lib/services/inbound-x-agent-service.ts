import { and, eq, inArray, or } from 'drizzle-orm'
import { agentRegistry } from '@shared/lib/agent-actor'
import { db } from '@shared/lib/db'
import { agentAcl, xAgentPolicies } from '@shared/lib/db/schema'
import type { ApiAgent } from '@shared/lib/types/api'
import type { AgentRole, SessionMetadataMap } from '@shared/lib/types/agent'
import { hasMinRole } from '@shared/lib/types/agent'
import type { InboundXAgentBlockedAgent, InboundXAgentCaller, InboundXAgentDetails, InboundXAgentSession } from '@shared/lib/types/inbound-x-agent-schema'
import { listAgentsWithStatus } from './agent-service'
import {
  evaluate as evaluateXAgentPolicy,
  type XAgentDecision,
} from './x-agent-policy-service'

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
  evaluatePolicy?: (callerSlug: string, operation: 'invoke' | 'read', targetSlug: string) => XAgentDecision | Promise<XAgentDecision>
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
  evaluatePolicy = evaluateXAgentPolicy,
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

  const targetUsers = new Set(
    aclRows
      .filter((row) => row.agentSlug === targetSlug && hasMinRole(row.role as AgentRole, 'user'))
      .map((row) => row.userId),
  )
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
  await Promise.all(agents
    .filter((agent) => agent.slug !== targetSlug)
    .map(async (agent) => {
      if (authMode) {
        const callerOwners = ownerUsersByAgent.get(agent.slug)
        if (!callerOwners || ![...callerOwners].some((userId) => targetUsers.has(userId))) return
      }

      const canAccess = !authMode || viewerCanAccessAll || viewerAgents.has(agent.slug)
      const avatar = agent.avatar ?? null
      const blocks = blockRows
        .filter((row) => row.caller === agent.slug || row.target === agent.slug)
        .map(({ caller, operation }) => ({ callerSlug: caller, operation }))
      const [decision, readDecision] = await Promise.all([
        evaluatePolicy(agent.slug, 'invoke', targetSlug),
        evaluatePolicy(agent.slug, 'read', targetSlug),
      ])
      if (blocks.length > 0) {
        blocked.push({ slug: agent.slug, displaySlug: agent.displaySlug, name: agent.name, avatar, canAccess, decision, readDecision, blocks })
      }
      if (decision === 'block') return
      callers.push({ slug: agent.slug, displaySlug: agent.displaySlug, name: agent.name, decision, readDecision, avatar, canAccess })
    }))
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

  return { sessions, callers: callers.sort(byName), blocked: blocked.sort(byName) }
}

export async function getInboundXAgentDetails(
  targetSlug: string,
  options: { authMode: boolean; viewerUserId?: string; viewerCanAccessAll?: boolean },
): Promise<InboundXAgentDetails> {
  const [metadata, agents, blockRows] = await Promise.all([
    agentRegistry.get(targetSlug).sessions.readMetadata(),
    listAgentsWithStatus(),
    db
      .select({ caller: xAgentPolicies.callerAgentSlug, target: xAgentPolicies.targetAgentSlug, operation: xAgentPolicies.operation })
      .from(xAgentPolicies)
      .where(and(
        eq(xAgentPolicies.decision, 'block'),
        or(
          eq(xAgentPolicies.targetAgentSlug, targetSlug),
          eq(xAgentPolicies.callerAgentSlug, targetSlug),
        ),
      )),
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
    blockRows: blockRows.flatMap(({ caller, target, operation }) =>
      target && (operation === 'read' || operation === 'invoke') ? [{ caller, target, operation }] : []),
  })
}

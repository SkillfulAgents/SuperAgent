import { inArray } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import type { ApiAgent } from '@shared/lib/types/api'
import type { AgentRole, SessionMetadataMap } from '@shared/lib/types/agent'
import { hasMinRole } from '@shared/lib/types/agent'
import type { InboundXAgentDetails } from '@shared/lib/types/inbound-x-agent-schema'
import { listAgentsWithStatus } from './agent-service'
import { readSessionMetadata } from './session-service'
import {
  evaluate as evaluateXAgentPolicy,
  type XAgentDecision,
} from './x-agent-policy-service'

interface AgentAclRow {
  agentSlug: string
  userId: string
  role: string
}

interface BuildInboundXAgentDetailsInput {
  targetSlug: string
  metadata: SessionMetadataMap
  agents: ApiAgent[]
  authMode: boolean
  viewerUserId?: string
  viewerCanAccessAll?: boolean
  aclRows: AgentAclRow[]
  evaluatePolicy?: (callerSlug: string, targetSlug: string) => XAgentDecision
}

/**
 * Build the permission-aware history payload without doing I/O. Keeping the
 * ACL/policy projection pure makes the security-sensitive visibility rules
 * straightforward to test independently of the route and database adapters.
 */
export function buildInboundXAgentDetails({
  targetSlug,
  metadata,
  agents,
  authMode,
  viewerUserId,
  viewerCanAccessAll = false,
  aclRows,
  evaluatePolicy = (callerSlug, target) => evaluateXAgentPolicy(callerSlug, 'invoke', target),
}: BuildInboundXAgentDetailsInput): InboundXAgentDetails {
  const agentBySlug = new Map(agents.map((agent) => [agent.slug, agent]))
  const sessions = Object.entries(metadata)
    .flatMap(([id, meta]) => {
      if (!meta.invokedByAgentSlug || !meta.createdAt) return []
      const createdAt = new Date(meta.createdAt)
      if (!Number.isFinite(createdAt.getTime())) return []
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

  const callers = agents
    .filter((agent) => agent.slug !== targetSlug)
    .flatMap((agent) => {
      if (authMode) {
        const callerOwners = ownerUsersByAgent.get(agent.slug)
        if (!callerOwners || ![...callerOwners].some((userId) => targetUsers.has(userId))) return []
      }

      const decision = evaluatePolicy(agent.slug, targetSlug)
      if (decision === 'block') return []
      return [{
        slug: agent.slug,
        displaySlug: agent.displaySlug,
        name: agent.name,
        decision,
        canAccess: !authMode || viewerCanAccessAll || viewerAgents.has(agent.slug),
      }]
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  return { sessions, callers }
}

export async function getInboundXAgentDetails(
  targetSlug: string,
  options: { authMode: boolean; viewerUserId?: string; viewerCanAccessAll?: boolean },
): Promise<InboundXAgentDetails> {
  const [metadata, agents] = await Promise.all([
    readSessionMetadata(targetSlug),
    listAgentsWithStatus(),
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
  })
}

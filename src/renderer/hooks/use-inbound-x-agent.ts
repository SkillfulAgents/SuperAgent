import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import {
  inboundXAgentDetailsSchema,
  type AgentAccessRole,
  type InboundXAgentBlockedAgent,
  type InboundXAgentCaller,
} from '@shared/lib/types/inbound-x-agent-schema'

/** One row of a caller's agent-to-agent policy, through the caller's own route. */
async function patchXAgentPolicy(
  callerSlug: string,
  change: { operation: 'invoke' | 'read'; targetSlug: string; decision: 'allow' | 'review' | 'block' | 'default' },
  failure: string,
) {
  const response = await apiFetch(`/api/agents/${encodeURIComponent(callerSlug)}/x-agent-policies`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error ?? failure)
  }
}

export function useInboundXAgentDetails(agentSlug: string | null, enabled = true) {
  return useQuery({
    queryKey: ['inbound-x-agent', agentSlug],
    queryFn: async () => {
      const response = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug!)}/inbound-x-agent`,
      )
      if (!response.ok) throw new Error('Failed to fetch calls from other agents')
      return inboundXAgentDetailsSchema.parse(await response.json())
    },
    enabled: !!agentSlug && enabled,
    staleTime: 30_000,
  })
}

export function useSetInboundXAgentPermission(targetAgentSlug: string) {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({
      callerAgentSlug,
      decision,
    }: {
      callerAgentSlug: string
      decision: 'allow' | 'review'
    }) => {
      await patchXAgentPolicy(callerAgentSlug, { operation: 'invoke', targetSlug: targetAgentSlug, decision }, 'Failed to update caller permission')
    },
    onSuccess: async (_data, { callerAgentSlug }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbound-x-agent', targetAgentSlug] }),
        queryClient.invalidateQueries({ queryKey: ['x-agent-policies', callerAgentSlug] }),
        queryClient.invalidateQueries({ queryKey: ['home-graph'] }),
      ])
    },
  })
}

export type AgentAccessChange = AgentAccessRole | 'remove' | 'block'

/**
 * Give another agent a role on this one, take it away, or block it, the way
 * the share popover does for people. A User messages this agent and reads its
 * sessions, a Viewer only reads; both are the other agent's own policies
 * toward this one, written through its policy route.
 *
 * Taking access away pins Review rather than clearing the row, as the calls
 * page's switch does: an agent whose default allows every agent would
 * otherwise keep its access. What is taken goes first, so a failure part-way
 * never leaves the agent with more than it was given. A block stops read and
 * invoke in both directions. Changing a blocked agent lifts its stored blocks
 * after the take-away and before the grant.
 */
export function useSetAgentAccess(targetAgentSlug: string) {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ agent, change }: {
      agent: Pick<InboundXAgentBlockedAgent, 'slug' | 'decision' | 'readDecision'> & Partial<Pick<InboundXAgentBlockedAgent, 'blocks'>>
      change: AgentAccessChange
    }) => {
      const set = (callerSlug: string, operation: 'invoke' | 'read', decision: 'allow' | 'review' | 'block' | 'default') =>
        patchXAgentPolicy(callerSlug, { operation, targetSlug: callerSlug === agent.slug ? targetAgentSlug : agent.slug, decision }, 'Failed to change access')
      if (change === 'block') {
        for (const callerSlug of [agent.slug, targetAgentSlug]) {
          await set(callerSlug, 'invoke', 'block')
          await set(callerSlug, 'read', 'block')
        }
        return
      }
      if (change !== 'user' && agent.decision === 'allow') await set(agent.slug, 'invoke', 'review')
      if (change === 'remove' && agent.readDecision === 'allow') await set(agent.slug, 'read', 'review')
      // Blocks lift only after what is taken away is gone, and to Review, not a deleted row: deleting could
      // hand back an allow the agent's own setting for every agent gives. The picked role is granted last.
      for (const block of agent.blocks ?? []) await set(block.callerSlug, block.operation, 'review')
      if (change === 'user' && agent.decision !== 'allow') await set(agent.slug, 'invoke', 'allow')
      if (change !== 'remove' && agent.readDecision !== 'allow') await set(agent.slug, 'read', 'allow')
    },
    // A change that failed part-way has still changed something: refetch either way.
    onSettled: async (_data, _error, { agent }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbound-x-agent', targetAgentSlug] }),
        queryClient.invalidateQueries({ queryKey: ['x-agent-policies', agent.slug] }),
        queryClient.invalidateQueries({ queryKey: ['x-agent-policies', targetAgentSlug] }),
        queryClient.invalidateQueries({ queryKey: ['home-graph'] }),
      ])
    },
  })
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { AGENT_MEMBER_AGENTS_QUERY_KEY } from './use-agent-member-agents'
import {
  inboundXAgentDetailsSchema,
  type AgentAccessRole,
  type InboundXAgentCaller,
} from '@shared/lib/types/inbound-x-agent-schema'

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
      const response = await apiFetch(
        `/api/agents/${encodeURIComponent(callerAgentSlug)}/x-agent-policies`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation: 'invoke',
            targetSlug: targetAgentSlug,
            decision,
          }),
        },
      )
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(payload?.error ?? 'Failed to update caller permission')
      }
    },
    onSuccess: async (_data, { callerAgentSlug }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbound-x-agent', targetAgentSlug] }),
        queryClient.invalidateQueries({ queryKey: ['x-agent-policies', callerAgentSlug] }),
        queryClient.invalidateQueries({ queryKey: ['home-graph'] }),
        queryClient.invalidateQueries({ queryKey: AGENT_MEMBER_AGENTS_QUERY_KEY }),
      ])
    },
  })
}

/**
 * Give another agent a role on this one, or take it away (`null`), the way the
 * share popover does for people. A User sends messages without asking and a
 * Viewer reads sessions and files; both are the caller's own agent-to-agent
 * permissions, so each change is a write to the caller's policies.
 *
 * Taking access away pins Review rather than clearing the row, as the calls
 * page's switch does: a caller whose default allows every agent would
 * otherwise keep its access. What is taken goes first, so a failure part-way
 * never leaves the agent with more than it was given.
 */
export function useSetAgentAccessRole(targetAgentSlug: string) {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ caller, role }: { caller: InboundXAgentCaller; role: AgentAccessRole | null }) => {
      const set = async (operation: 'invoke' | 'read', decision: 'allow' | 'review') => {
        const response = await apiFetch(
          `/api/agents/${encodeURIComponent(caller.slug)}/x-agent-policies`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operation, targetSlug: targetAgentSlug, decision }),
          },
        )
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { error?: string } | null
          throw new Error(payload?.error ?? 'Failed to change access')
        }
      }
      if (role !== 'user' && caller.decision === 'allow') await set('invoke', 'review')
      if (role === null && caller.readDecision === 'allow') await set('read', 'review')
      if (role === 'user' && caller.decision !== 'allow') await set('invoke', 'allow')
      if (role === 'viewer' && caller.readDecision !== 'allow') await set('read', 'allow')
    },
    // A change that failed part-way has still changed something: refetch either way.
    onSettled: async (_data, _error, { caller }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbound-x-agent', targetAgentSlug] }),
        queryClient.invalidateQueries({ queryKey: ['x-agent-policies', caller.slug] }),
        queryClient.invalidateQueries({ queryKey: ['home-graph'] }),
        queryClient.invalidateQueries({ queryKey: AGENT_MEMBER_AGENTS_QUERY_KEY }),
      ])
    },
  })
}

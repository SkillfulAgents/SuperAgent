import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { inboundXAgentDetailsSchema, type AgentAccessChange } from '@shared/lib/types/inbound-x-agent-schema'

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
      ])
    },
  })
}

/**
 * Give another agent a role on this one, take it away, or block it, the way
 * the share popover does for people. The server sets both of the other
 * agent's permissions toward this one from what is stored, in one write.
 */
export function useSetAgentAccess(targetAgentSlug: string) {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ callerSlug, change }: { callerSlug: string; change: AgentAccessChange }) => {
      const response = await apiFetch(`/api/agents/${encodeURIComponent(targetAgentSlug)}/inbound-x-agent/${encodeURIComponent(callerSlug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ change }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(payload?.error ?? 'Failed to change access')
      }
    },
    onSettled: async (_data, _error, { callerSlug }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbound-x-agent', targetAgentSlug] }),
        queryClient.invalidateQueries({ queryKey: ['x-agent-policies', callerSlug] }),
        queryClient.invalidateQueries({ queryKey: ['x-agent-policies', targetAgentSlug] }),
        queryClient.invalidateQueries({ queryKey: ['home-graph'] }),
      ])
    },
  })
}

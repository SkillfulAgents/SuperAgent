import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { inboundXAgentDetailsSchema } from '@shared/lib/types/inbound-x-agent-schema'

export function useInboundXAgentDetails(agentSlug: string | null) {
  return useQuery({
    queryKey: ['inbound-x-agent', agentSlug],
    queryFn: async () => {
      const response = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug!)}/inbound-x-agent`,
      )
      if (!response.ok) throw new Error('Failed to fetch calls from other agents')
      return inboundXAgentDetailsSchema.parse(await response.json())
    },
    enabled: !!agentSlug,
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

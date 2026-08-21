import { useQuery } from '@tanstack/react-query'
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

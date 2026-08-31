import { apiFetch } from '@renderer/lib/api'
import { useQuery } from '@tanstack/react-query'

export interface AgentMember {
  userId: string
  userName: string
  userEmail: string
}

export function useAgentMembers(agentSlug: string | null) {
  return useQuery<AgentMember[]>({
    queryKey: ['agent-access', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug!)}/access`)
      if (!res.ok) throw new Error('Failed to fetch members')
      return res.json()
    },
    enabled: !!agentSlug,
    staleTime: 60_000,
  })
}

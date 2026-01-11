import { useQuery } from '@tanstack/react-query'
import type { Skill } from '@/lib/skills'

export function useAgentSkills(agentId: string | null) {
  return useQuery<Skill[]>({
    queryKey: ['agent-skills', agentId],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agentId}/skills`)
      if (!res.ok) throw new Error('Failed to fetch skills')
      const data = await res.json()
      return data.skills
    },
    enabled: !!agentId,
  })
}

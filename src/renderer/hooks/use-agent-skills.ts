import { apiFetch } from '@renderer/lib/api'
import { useQuery } from '@tanstack/react-query'
import type { Skill } from '@shared/lib/skills'

export function useAgentSkills(agentSlug: string | null) {
  return useQuery<Skill[]>({
    queryKey: ['agent-skills', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/skills`)
      if (!res.ok) throw new Error('Failed to fetch skills')
      const data = await res.json()
      return data.skills
    },
    enabled: !!agentSlug,
  })
}

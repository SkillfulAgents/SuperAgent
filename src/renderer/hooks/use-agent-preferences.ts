import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentPreferences } from '@shared/lib/types/agent-preferences'

export function useAgentPreferences(agentSlug: string) {
  return useQuery<AgentPreferences>({
    queryKey: ['agent-preferences', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/preferences`)
      if (!res.ok) throw new Error('Failed to fetch agent preferences')
      return res.json()
    },
    enabled: !!agentSlug,
  })
}

type AgentPreferencesUpdate = {
  [K in keyof AgentPreferences]?: AgentPreferences[K] | null
}

export function useUpdateAgentPreferences(agentSlug: string) {
  const queryClient = useQueryClient()
  return useMutation<AgentPreferences, Error, AgentPreferencesUpdate>({
    mutationFn: async (data) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to update agent preferences')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-preferences', agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

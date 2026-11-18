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
  // No skipGlobalErrorToast: every caller is a fire-and-forget control (a
  // dropdown, a picker), so the global toast is the only failure signal.
  return useMutation<AgentPreferences, Error, AgentPreferencesUpdate>({
    mutationFn: async (data) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(payload?.error || 'Failed to update agent preferences')
      }
      return res.json()
    },
    // The PUT answers with the preferences as the GET would (default model
    // resolved against the connections), so the response is the refresh: the
    // cache holds it before the control leaves its pending state, and nothing
    // is read again. No agent list or detail field comes from preferences.
    onSuccess: (preferences) => {
      queryClient.setQueryData<AgentPreferences>(['agent-preferences', agentSlug], preferences)
    },
  })
}

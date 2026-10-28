import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentHook, RemoveAgentHookTarget } from '@shared/lib/services/agent-hooks-schema'

/** Claude Code hooks configured in the agent workspace settings file. */
export function useAgentHooks(agentSlug: string | null) {
  return useQuery<AgentHook[]>({
    queryKey: ['agent-hooks', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/hooks`)
      if (!res.ok) return []
      const data = await res.json()
      return Array.isArray(data?.hooks) ? data.hooks : []
    },
    enabled: !!agentSlug,
    staleTime: 30_000,
  })
}

export function useRemoveAgentHook(agentSlug: string | null) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (target: RemoveAgentHookTarget) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/hooks`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      })
      if (!res.ok) throw new Error('Failed to remove hook')
      const data = await res.json()
      return (Array.isArray(data?.hooks) ? data.hooks : []) as AgentHook[]
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['agent-hooks', agentSlug], data)
    },
  })
}

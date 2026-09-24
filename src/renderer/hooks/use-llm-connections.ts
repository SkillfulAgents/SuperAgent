import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import type { ConnectionInfo, ModelSelection } from '@shared/lib/llm-provider/connection-schema'

export interface ConnectionsResponse {
  legacyLlmProviderId?: string
  connections: ConnectionInfo[]
  defaultSelection: ModelSelection | null
  summarizerSelection: ModelSelection | null
}
export function useLlmConnections(
  agentSlug?: string,
  sessionId?: string,
  currentLlmProviderId?: string | null
) {
  return useQuery<ConnectionsResponse>({
    queryKey: ['settings', 'llm-connections', agentSlug, sessionId, currentLlmProviderId],
    queryFn: async () => {
      const root = await apiFetch('/api/llm-connections')
      if (!root.ok) throw new Error('Could not load model connections')
      const data: ConnectionsResponse = await root.json()
      if (agentSlug) {
        const response = await apiFetch(
          sessionId
            ? `/api/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}/llm-connections`
            : `/api/agents/${encodeURIComponent(agentSlug)}/llm-connections`
        )
        if (!response.ok) throw new Error('Could not load session connection')
        const current: { connections: ConnectionInfo[] } = await response.json()
        data.connections = current.connections
      }
      return data
    },
    staleTime: 10_000,
  })
}
export function useConnectionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      path = '',
      method = 'POST',
      body,
    }: {
      path?: string
      method?: string
      body?: unknown
    }) => {
      const response = await apiFetch(`/api/llm-connections${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Could not update connection')
      return result
    },
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['settings'] }),
      queryClient.invalidateQueries({ queryKey: ['runtime-status'] }),
    ]),
  })
}

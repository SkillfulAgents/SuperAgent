import { apiFetch, apiJson } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import type { ApiSession } from '@shared/lib/types/api'
import type { EffortLevel } from '@shared/lib/container/types'

// Re-export for convenience
export type { ApiSession }

export function useSessions(agentSlug: string | null, options?: { staleTime?: number }) {
  return useQuery<ApiSession[]>({
    queryKey: ['sessions', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions`)
      if (!res.ok) throw new Error('Failed to fetch sessions')
      return res.json()
    },
    enabled: !!agentSlug,
    staleTime: options?.staleTime,
  })
}

export function useSession(id: string | null, agentSlug: string | null = null) {
  return useQuery<ApiSession>({
    queryKey: ['session', id, agentSlug],
    // `apiJson` throws `HttpError` so the session leaf can tell a genuine 404
    // (deep-link to a non-existent session) from a transient one (R17).
    queryFn: () => apiJson<ApiSession>(`/api/agents/${agentSlug}/sessions/${id}`),
    enabled: !!id && !!agentSlug,
    // KEEP the default retry (do NOT skip 404): a just-created session can 404
    // transiently while the backend catches up, so retrying masks the
    // create-then-navigate race. SessionView's not-found guard reads `error`,
    // which React Query only sets once retries are exhausted — i.e. only for a
    // genuinely missing session, never a still-settling new one.
  })
}

export function useCreateSession() {
  const queryClient = useQueryClient()
  const { track } = useAnalyticsTracking()

  return useMutation({
    mutationFn: async (data: { agentSlug: string; message: string; effort?: EffortLevel; model?: string }) => {
      const res = await apiFetch(`/api/agents/${data.agentSlug}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: data.message,
          ...(data.effort ? { effort: data.effort } : {}),
          ...(data.model ? { model: data.model } : {}),
        }),
      })
      if (!res.ok) throw new Error('Failed to create session')
      // initialMessageUuid is the server-assigned id of the initial message,
      // used to materialize the optimistic pending copy by exact id match.
      return res.json() as Promise<ApiSession & { initialMessageUuid: string }>
    },
    onSuccess: (_, variables) => {
      track('session_created')
      track('message_sent')
      queryClient.invalidateQueries({ queryKey: ['sessions', variables.agentSlug] })
    },
  })
}

export function useDeleteSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, agentSlug }: { id: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete session')
      // 204 No Content - no body to parse
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['sessions', variables.agentSlug] })
    },
  })
}

export function useUpdateSessionName() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ sessionId, agentSlug, name }: { sessionId: string; agentSlug: string; name: string }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error('Failed to update session name')
      return res.json() as Promise<ApiSession>
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['sessions', variables.agentSlug] })
    },
  })
}

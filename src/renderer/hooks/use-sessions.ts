import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiSession } from '@shared/lib/types/api'

// Re-export for convenience
export type { ApiSession }

export function useSessions(agentSlug: string | null) {
  return useQuery<ApiSession[]>({
    queryKey: ['sessions', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions`)
      if (!res.ok) throw new Error('Failed to fetch sessions')
      return res.json()
    },
    enabled: !!agentSlug,
  })
}

export function useSession(id: string | null, agentSlug: string | null = null) {
  return useQuery<ApiSession>({
    queryKey: ['session', id, agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${id}`)
      if (!res.ok) throw new Error('Failed to fetch session')
      return res.json()
    },
    enabled: !!id && !!agentSlug,
  })
}

export function useCreateSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { agentSlug: string; message: string }) => {
      const res = await apiFetch(`/api/agents/${data.agentSlug}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: data.message }),
      })
      if (!res.ok) throw new Error('Failed to create session')
      return res.json() as Promise<ApiSession>
    },
    onSuccess: (_, variables) => {
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

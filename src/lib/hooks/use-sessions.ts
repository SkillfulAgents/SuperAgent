import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Session } from '@/lib/db/schema'

// Extended session type that includes runtime status
export interface SessionWithStatus extends Session {
  isActive: boolean
}

export function useSessions(agentId: string | null) {
  return useQuery<SessionWithStatus[]>({
    queryKey: ['sessions', agentId],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agentId}/sessions`)
      if (!res.ok) throw new Error('Failed to fetch sessions')
      return res.json()
    },
    enabled: !!agentId,
  })
}

export function useSession(id: string | null) {
  return useQuery<SessionWithStatus>({
    queryKey: ['session', id],
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${id}`)
      if (!res.ok) throw new Error('Failed to fetch session')
      return res.json()
    },
    enabled: !!id,
  })
}

export function useCreateSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { agentId: string; message: string }) => {
      const res = await fetch(`/api/agents/${data.agentId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: data.message }),
      })
      if (!res.ok) throw new Error('Failed to create session')
      return res.json()
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['sessions', variables.agentId] })
    },
  })
}

export function useDeleteSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete session')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })
}

export function useUpdateSessionName() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ sessionId, name }: { sessionId: string; name: string }) => {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error('Failed to update session name')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })
}

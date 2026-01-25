import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiMessage } from '@shared/lib/types/api'

// Re-export for convenience
export type { ApiMessage }

export function useMessages(sessionId: string | null, agentSlug: string | null) {
  return useQuery<ApiMessage[]>({
    queryKey: ['messages', sessionId, agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/messages`)
      if (!res.ok) throw new Error('Failed to fetch messages')
      return res.json()
    },
    enabled: !!sessionId && !!agentSlug,
    // Refetch periodically to catch any messages we might have missed
    refetchInterval: 5000,
  })
}

export function useSendMessage() {
  return useMutation({
    mutationFn: async (data: { sessionId: string; agentSlug: string; content: string }) => {
      const res = await apiFetch(`/api/agents/${data.agentSlug}/sessions/${data.sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: data.content }),
      })
      if (!res.ok) throw new Error('Failed to send message')
      return res.json()
    },
    // No onSuccess - we'll handle the pending message via props
  })
}

export function useInterruptSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ sessionId, agentSlug }: { sessionId: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/interrupt`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Failed to interrupt session')
      return res.json()
    },
    onSuccess: (_, { sessionId }) => {
      // Invalidate messages to refresh state
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
    },
  })
}

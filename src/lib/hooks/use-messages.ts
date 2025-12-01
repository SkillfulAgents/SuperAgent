import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Message } from '@/lib/db/schema'

export function useMessages(sessionId: string | null) {
  return useQuery<Message[]>({
    queryKey: ['messages', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/messages`)
      if (!res.ok) throw new Error('Failed to fetch messages')
      return res.json()
    },
    enabled: !!sessionId,
    // Refetch periodically to catch any messages we might have missed
    refetchInterval: 5000,
  })
}

export function useSendMessage() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { sessionId: string; agentId: string; content: string }) => {
      const res = await fetch(`/api/sessions/${data.sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: data.content }),
      })
      if (!res.ok) throw new Error('Failed to send message')
      return res.json()
    },
    onSuccess: (_, variables) => {
      // Invalidate messages to show the user's message immediately
      queryClient.invalidateQueries({ queryKey: ['messages', variables.sessionId] })
    },
  })
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Message, ToolCall } from '@/lib/db/schema'

// API response type includes tool calls for each message
export interface MessageWithToolCalls extends Message {
  toolCalls: ToolCall[]
}

export function useMessages(sessionId: string | null) {
  return useQuery<MessageWithToolCalls[]>({
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

export function useInterruptSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await fetch(`/api/sessions/${sessionId}/interrupt`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Failed to interrupt session')
      return res.json()
    },
    onSuccess: (_, sessionId) => {
      // Invalidate messages to refresh state
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId] })
    },
  })
}

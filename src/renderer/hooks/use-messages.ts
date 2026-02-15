import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiMessage, ApiMessageOrBoundary } from '@shared/lib/types/api'

// Re-export for convenience
export type { ApiMessage, ApiMessageOrBoundary }

export function useMessages(sessionId: string | null, agentSlug: string | null) {
  return useQuery<ApiMessageOrBoundary[]>({
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

export function useUploadFile() {
  return useMutation({
    mutationFn: async (data: { sessionId: string; agentSlug: string; file: File }) => {
      const formData = new FormData()
      formData.append('file', data.file)
      const res = await apiFetch(
        `/api/agents/${data.agentSlug}/sessions/${data.sessionId}/upload-file`,
        { method: 'POST', body: formData }
      )
      if (!res.ok) throw new Error('Failed to upload file')
      return res.json() as Promise<{ path: string; filename: string; size: number }>
    },
  })
}

export function useDeleteMessage() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ sessionId, agentSlug, messageId }: { sessionId: string; agentSlug: string; messageId: string }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/messages/${messageId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Failed to delete message')
    },
    onSuccess: (_, { sessionId, agentSlug }) => {
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId, agentSlug] })
    },
  })
}

export function useDeleteToolCall() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ sessionId, agentSlug, toolCallId }: { sessionId: string; agentSlug: string; toolCallId: string }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/tool-calls/${toolCallId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Failed to delete tool call')
    },
    onSuccess: (_, { sessionId, agentSlug }) => {
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId, agentSlug] })
    },
  })
}

export function useSubagentMessages(
  sessionId: string | null,
  agentSlug: string | null,
  subagentId: string | null
) {
  return useQuery<ApiMessageOrBoundary[]>({
    queryKey: ['subagent-messages', sessionId, agentSlug, subagentId],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/subagent/${subagentId}/messages`
      )
      if (!res.ok) throw new Error('Failed to fetch subagent messages')
      return res.json()
    },
    enabled: !!sessionId && !!agentSlug && !!subagentId,
    refetchInterval: false,
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

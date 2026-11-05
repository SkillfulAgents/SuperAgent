import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useUser } from '@renderer/context/user-context'
import {
  threadRepliesResponseSchema,
  threadSummariesResponseSchema,
  type ThreadReply,
  type ThreadSummary,
} from '@shared/lib/session-threads/thread-schema'

/**
 * Threads on a session's messages. One query per session feeds every reply
 * row under its messages; the drawer reads one thread. The session stream's
 * `thread_replies_updated` event invalidates both (use-message-stream).
 */

export function threadsQueryKey(sessionId: string) {
  return ['session-threads', sessionId] as const
}

function threadsPath(agentSlug: string, sessionId: string) {
  return `/api/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}/threads`
}

const NO_THREADS = new Map<string, ThreadSummary>()

/** The session's threads, by the message each is on. Empty outside auth mode. */
export function useThreadSummaries(agentSlug: string | undefined, sessionId: string | null | undefined) {
  const { isAuthMode } = useUser()
  const query = useQuery({
    queryKey: [...threadsQueryKey(sessionId ?? ''), 'summaries', agentSlug],
    queryFn: async ({ signal }) => {
      const res = await apiFetch(threadsPath(agentSlug!, sessionId!), { signal })
      if (!res.ok) throw new Error('Failed to load threads')
      const { threads } = threadSummariesResponseSchema.parse(await res.json())
      return new Map(threads.map((thread) => [thread.parentMessageUuid, thread]))
    },
    enabled: isAuthMode && !!agentSlug && !!sessionId,
    staleTime: 30_000,
  })
  return query.data ?? NO_THREADS
}

export function useThreadReplies(agentSlug: string, sessionId: string, parentMessageUuid: string | null) {
  return useQuery({
    queryKey: [...threadsQueryKey(sessionId), 'replies', agentSlug, parentMessageUuid],
    queryFn: async ({ signal }): Promise<ThreadReply[]> => {
      const res = await apiFetch(`${threadsPath(agentSlug, sessionId)}/${encodeURIComponent(parentMessageUuid!)}`, { signal })
      if (!res.ok) throw new Error('Failed to load thread')
      return threadRepliesResponseSchema.parse(await res.json()).replies
    },
    enabled: !!parentMessageUuid,
  })
}

export function useSendThreadReply(agentSlug: string, sessionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: { parentMessageUuid: string; text: string; taggedUserIds: string[] }) => {
      const res = await apiFetch(`${threadsPath(agentSlug, sessionId)}/${encodeURIComponent(data.parentMessageUuid)}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: data.text, taggedUserIds: data.taggedUserIds }),
      })
      if (!res.ok) throw new Error('Failed to send reply')
      return res.json() as Promise<{ id: string; createdAt: string }>
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: threadsQueryKey(sessionId) }),
  })
}

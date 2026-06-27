import { apiFetch } from '@renderer/lib/api'
import { uploadFileChunked } from '@renderer/lib/upload'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiMessage, ApiMessageOrBoundary } from '@shared/lib/types/api'
import type { EffortLevel } from '@shared/lib/container/types'
import type { WorkflowTree } from '@shared/lib/workflows/workflow-schemas'

// Re-export for convenience
export type { ApiMessage, ApiMessageOrBoundary }

/**
 * Thrown when the session's JSONL transcript is absent (HTTP 404) — e.g. it was
 * deleted by the CLI's retention cleanup while the metadata entry lingers in the
 * nav. Distinct from a generic fetch failure so the UI can show a clear message.
 */
export class TranscriptNotFoundError extends Error {
  constructor() {
    super('Session transcript not found')
    this.name = 'TranscriptNotFoundError'
  }
}

export function useMessages(sessionId: string | null, agentSlug: string | null) {
  return useQuery<ApiMessageOrBoundary[]>({
    queryKey: ['messages', sessionId, agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/messages`)
      if (res.status === 404) throw new TranscriptNotFoundError()
      if (!res.ok) throw new Error('Failed to fetch messages')
      return res.json()
    },
    enabled: !!sessionId && !!agentSlug,
    // A missing transcript won't reappear — don't hammer it with retries.
    retry: (failureCount, error) =>
      !(error instanceof TranscriptNotFoundError) && failureCount < 3,
    // Safety-net poll for any messages the SSE stream missed. The stream
    // (use-message-stream) is the primary, near-instant path; this only
    // backstops out-of-band edits / a silently-stalled SSE.
    // TODO: conservative first step down from the original 5s. Once we've
    // confirmed nothing relies on tight polling, this can be raised further
    // (e.g. 30s) or gated on SSE-connection health.
    refetchInterval: 15000,
  })
}

export function useSendMessage() {
  return useMutation({
    mutationFn: async (data: { sessionId: string; agentSlug: string; content: string; effort?: EffortLevel; model?: string }) => {
      const res = await apiFetch(`/api/agents/${data.agentSlug}/sessions/${data.sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: data.content,
          ...(data.effort ? { effort: data.effort } : {}),
          ...(data.model ? { model: data.model } : {}),
        }),
      })
      if (!res.ok) throw new Error('Failed to send message')
      // uuid is the server-assigned message id, used to materialize the
      // optimistic pending copy by exact id match.
      return res.json() as Promise<{ success: boolean; uuid: string; queued: boolean }>
    },
    // No onSuccess - we'll handle the pending message via props
  })
}

export function useCancelQueuedMessage() {
  return useMutation({
    mutationFn: async (data: { sessionId: string; agentSlug: string; uuid: string }) => {
      const res = await apiFetch(
        `/api/agents/${data.agentSlug}/sessions/${data.sessionId}/queued-messages/${encodeURIComponent(data.uuid)}`,
        { method: 'DELETE' }
      )
      if (!res.ok) throw new Error('Failed to cancel queued message')
      // cancelled: false = the agent already picked the message up; the
      // caller leaves the ghost alone and lets it materialize normally.
      return res.json() as Promise<{ cancelled: boolean }>
    },
  })
}

export function useUploadFile() {
  return useMutation({
    mutationFn: async (data: { sessionId: string; agentSlug: string; file: File; relativePath?: string }) => {
      return uploadFileChunked<{ path: string; filename: string; size: number }>({
        url: `/api/agents/${data.agentSlug}/sessions/${data.sessionId}/upload-file`,
        file: data.file,
        fields: data.relativePath ? { relativePath: data.relativePath } : undefined,
      })
    },
  })
}

export function useUploadFolder() {
  return useMutation({
    mutationFn: async (data: { sessionId?: string; agentSlug: string; sourcePath: string }) => {
      const url = data.sessionId
        ? `/api/agents/${data.agentSlug}/sessions/${data.sessionId}/upload-folder`
        : `/api/agents/${data.agentSlug}/upload-folder`
      const res = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: data.sourcePath }),
      })
      if (!res.ok) throw new Error('Failed to upload folder')
      return res.json() as Promise<{ path: string; folderName: string }>
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

/**
 * The per-agent tree (phases + agent status/label/result) for a dynamic-workflow
 * run, joined host-side from on-disk artifacts. Disk is the source of truth (so
 * this survives reload); the drawer overlays live SSE status patches and triggers
 * a refetch via the returned `refetch` when a workflow_agent_updated arrives.
 */
export function useWorkflowTree(
  sessionId: string | null,
  agentSlug: string | null,
  runId: string | null,
  opts?: { active?: boolean }
) {
  return useQuery<WorkflowTree>({
    queryKey: ['workflow-tree', sessionId, agentSlug, runId],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/workflows/${runId}/tree`
      )
      if (!res.ok) throw new Error('Failed to fetch workflow tree')
      return res.json()
    },
    enabled: !!sessionId && !!agentSlug && !!runId,
    // While the run is active, poll: right after launch the on-disk dir doesn't exist yet
    // (the tree route 404s), and new agents/labels appear as the run progresses. Stops once
    // the workflow completes (SSE-driven refetch handles the final state).
    refetchInterval: opts?.active ? 2000 : false,
    retry: opts?.active ? 5 : false,
  })
}

/**
 * One workflow subagent's transcript (same shape as a regular subagent). Polls
 * while that agent is still running so its live activity streams into the drawer;
 * stops once it's done.
 */
export function useWorkflowAgentMessages(
  sessionId: string | null,
  agentSlug: string | null,
  runId: string | null,
  agentId: string | null,
  opts?: { isRunning?: boolean }
) {
  return useQuery<ApiMessageOrBoundary[]>({
    queryKey: ['workflow-agent-messages', sessionId, agentSlug, runId, agentId],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/workflows/${runId}/agents/${agentId}/messages`
      )
      if (!res.ok) throw new Error('Failed to fetch workflow agent messages')
      return res.json()
    },
    enabled: !!sessionId && !!agentSlug && !!runId && !!agentId,
    refetchInterval: opts?.isRunning ? 1500 : false,
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

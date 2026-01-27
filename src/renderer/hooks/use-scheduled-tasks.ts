/**
 * Scheduled Tasks Hooks
 *
 * React Query hooks for managing scheduled tasks.
 */

import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiScheduledTask } from '@shared/lib/types/api'

// Re-export for convenience
export type { ApiScheduledTask }

/**
 * Fetch all scheduled tasks for an agent
 */
export function useScheduledTasks(agentSlug: string | null, status?: 'pending') {
  return useQuery<ApiScheduledTask[]>({
    queryKey: ['scheduled-tasks', agentSlug, status],
    queryFn: async () => {
      const url = status
        ? `/api/agents/${agentSlug}/scheduled-tasks?status=${status}`
        : `/api/agents/${agentSlug}/scheduled-tasks`
      const res = await apiFetch(url)
      if (!res.ok) throw new Error('Failed to fetch scheduled tasks')
      return res.json()
    },
    enabled: !!agentSlug,
  })
}

/**
 * Fetch a single scheduled task by ID
 */
export function useScheduledTask(taskId: string | null) {
  return useQuery<ApiScheduledTask>({
    queryKey: ['scheduled-task', taskId],
    queryFn: async () => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}`)
      if (!res.ok) throw new Error('Failed to fetch scheduled task')
      return res.json()
    },
    enabled: !!taskId,
  })
}

/**
 * Cancel a scheduled task
 */
export function useCancelScheduledTask() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ taskId, agentSlug }: { taskId: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to cancel scheduled task')
      // 204 No Content - no body to parse
      return { taskId, agentSlug }
    },
    onSuccess: (_, variables) => {
      // Invalidate all scheduled tasks queries for this agent
      queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', variables.agentSlug] })
      // Invalidate the specific task query
      queryClient.invalidateQueries({ queryKey: ['scheduled-task', variables.taskId] })
    },
  })
}

/**
 * Fetch all sessions created by a scheduled task
 */
export function useScheduledTaskSessions(taskId: string | null) {
  return useQuery<Array<{ id: string; name: string; createdAt: string; lastActivityAt: string; messageCount: number }>>({
    queryKey: ['scheduled-task-sessions', taskId],
    queryFn: async () => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}/sessions`)
      if (!res.ok) throw new Error('Failed to fetch sessions for scheduled task')
      return res.json()
    },
    enabled: !!taskId,
  })
}

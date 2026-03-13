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
 * Update a scheduled task's timezone
 */
export function useUpdateScheduledTaskTimezone() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ taskId, timezone }: { taskId: string; timezone: string }) => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}/timezone`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone }),
      })
      if (!res.ok) throw new Error('Failed to update timezone')
      return res.json() as Promise<ApiScheduledTask>
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-task', data.id] })
      queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', data.agentSlug] })
    },
  })
}

/**
 * Run a scheduled task immediately
 */
export function useRunScheduledTaskNow() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ taskId }: { taskId: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}/run-now`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Failed to run scheduled task')
      return res.json() as Promise<{ sessionId: string; agentSlug: string; task: ApiScheduledTask }>
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-task', variables.taskId] })
      queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', variables.agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['scheduled-task-sessions', variables.taskId] })
      queryClient.invalidateQueries({ queryKey: ['sessions', variables.agentSlug] })
    },
  })
}

/**
 * Describe a cron schedule in English using the summarizer LLM
 */
export function useDescribeSchedule() {
  return useMutation({
    mutationFn: async ({ taskId }: { taskId: string }) => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}/describe-schedule`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Failed to describe schedule')
      return res.json() as Promise<{ description: string }>
    },
  })
}

/**
 * Parse an English description into a cron expression using the summarizer LLM
 */
export function useParseSchedule() {
  return useMutation({
    mutationFn: async ({ taskId, description }: { taskId: string; description: string }) => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}/parse-schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to parse schedule')
      }
      return res.json() as Promise<{ expression: string }>
    },
  })
}

/**
 * Update a recurring task's cron expression
 */
export function useUpdateSchedule() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ taskId, scheduleExpression }: { taskId: string; scheduleExpression: string }) => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}/schedule`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduleExpression }),
      })
      if (!res.ok) throw new Error('Failed to update schedule')
      return res.json() as Promise<ApiScheduledTask>
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-task', data.id] })
      queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', data.agentSlug] })
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

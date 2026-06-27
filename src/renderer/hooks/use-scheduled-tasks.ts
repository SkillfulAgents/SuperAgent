/**
 * Scheduled Tasks Hooks
 *
 * React Query hooks for managing scheduled tasks.
 */

import { apiFetch } from '@renderer/lib/api'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiScheduledTask } from '@shared/lib/types/api'
import {
  useAutomationList,
  useAutomationDetail,
  useCancelAutomation,
  useAutomationSessions,
} from './use-agent-automations'

// Re-export for convenience
export type { ApiScheduledTask }

const TYPE = 'scheduled-tasks' as const

/**
 * Fetch all scheduled tasks for an agent
 */
export function useScheduledTasks(agentSlug: string | null, status?: 'pending' | 'cancelled') {
  return useAutomationList<ApiScheduledTask>(TYPE, agentSlug, status)
}

/**
 * Fetch a single scheduled task by ID
 */
export function useScheduledTask(taskId: string | null) {
  return useAutomationDetail<ApiScheduledTask>(TYPE, taskId)
}

/**
 * Cancel a scheduled task
 */
export function useCancelScheduledTask() {
  return useCancelAutomation(TYPE)
}

/**
 * Fetch all sessions created by a scheduled task
 */
export function useScheduledTaskSessions(taskId: string | null) {
  return useAutomationSessions(TYPE, taskId)
}

// ---------------------------------------------------------------------------
// Scheduled-task-specific hooks (no webhook-trigger equivalent)
// ---------------------------------------------------------------------------

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
 * Pause a recurring cron task
 */
export function usePauseScheduledTask() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ taskId }: { taskId: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}/pause`, {
        method: 'POST',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to pause scheduled task')
      }
      return res.json() as Promise<ApiScheduledTask>
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-task', variables.taskId] })
      queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', variables.agentSlug] })
    },
  })
}

/**
 * Resume a paused cron task
 */
export function useResumeScheduledTask() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ taskId }: { taskId: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}/resume`, {
        method: 'POST',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to resume scheduled task')
      }
      return res.json() as Promise<ApiScheduledTask>
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-task', variables.taskId] })
      queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', variables.agentSlug] })
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
    meta: { skipGlobalErrorToast: true },
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
    meta: { skipGlobalErrorToast: true },
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
 * Update a scheduled task's prompt
 */
export function useUpdateScheduledTaskPrompt() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ taskId, prompt }: { taskId: string; agentSlug: string; prompt: string }) => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}/prompt`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to update prompt')
      }
      return res.json() as Promise<ApiScheduledTask>
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-task', data.id] })
      queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', data.agentSlug] })
    },
  })
}

/**
 * Update a scheduled task's display name
 */
export function useUpdateScheduledTaskName() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ taskId, name }: { taskId: string; agentSlug: string; name: string }) => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to update name')
      }
      return res.json() as Promise<ApiScheduledTask>
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-task', data.id] })
      queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', data.agentSlug] })
    },
  })
}

/**
 * Update a scheduled task's runtime options (model and/or effort)
 */
export function useUpdateScheduledTaskRuntimeOptions() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ taskId, model, effort }: { taskId: string; agentSlug: string; model?: string | null; effort?: string | null }) => {
      const body: Record<string, string | null> = {}
      if (model !== undefined) body.model = model
      if (effort !== undefined) body.effort = effort
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}/runtime-options`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to update runtime options')
      }
      return res.json() as Promise<ApiScheduledTask>
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-task', data.id] })
      queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', data.agentSlug] })
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
      // The route appends a top-level `warning` when the new cadence is below the
      // recommended minimum interval; surface it to the caller.
      return res.json() as Promise<ApiScheduledTask & { warning?: string }>
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-task', data.id] })
      queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', data.agentSlug] })
    },
  })
}

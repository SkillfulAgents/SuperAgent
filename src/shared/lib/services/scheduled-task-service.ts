/**
 * Scheduled Task Service
 *
 * Database operations for scheduled tasks.
 * Handles creating, listing, updating, and cancelling scheduled tasks.
 */

import { db } from '@shared/lib/db'
import { scheduledTasks, type ScheduledTask, type NewScheduledTask } from '@shared/lib/db/schema'
import { eq, and, lte, inArray } from 'drizzle-orm'
import { getNextCronTime, parseAtSyntax } from './schedule-parser'
import { trackServerEvent } from '../analytics/server-analytics'

// Re-export the ScheduledTask type for external use
export type { ScheduledTask, NewScheduledTask }

// ============================================================================
// Types
// ============================================================================

export interface CreateScheduledTaskParams {
  agentSlug: string
  scheduleType: 'at' | 'cron'
  scheduleExpression: string
  prompt: string
  name?: string
  createdBySessionId?: string
  timezone?: string
}

export interface UpdateNextExecutionParams {
  taskId: string
  nextTime: Date
  sessionId: string
}

// ============================================================================
// Create Operations
// ============================================================================

/**
 * Create a new scheduled task
 */
export async function createScheduledTask(
  params: CreateScheduledTaskParams
): Promise<string> {
  const id = crypto.randomUUID()

  // Calculate next execution time based on schedule type (timezone-aware)
  const tz = params.timezone || undefined
  let nextExecutionAt: Date
  if (params.scheduleType === 'at') {
    nextExecutionAt = parseAtSyntax(params.scheduleExpression, tz)
  } else {
    nextExecutionAt = getNextCronTime(params.scheduleExpression, tz)
  }

  const newTask: NewScheduledTask = {
    id,
    agentSlug: params.agentSlug,
    scheduleType: params.scheduleType,
    scheduleExpression: params.scheduleExpression,
    prompt: params.prompt,
    name: params.name,
    status: 'pending',
    nextExecutionAt,
    isRecurring: params.scheduleType === 'cron',
    executionCount: 0,
    createdAt: new Date(),
    createdBySessionId: params.createdBySessionId,
    timezone: params.timezone || null,
  }

  await db.insert(scheduledTasks).values(newTask)

  trackServerEvent('task_scheduled', {
    scheduleType: params.scheduleType,
    isRecurring: params.scheduleType === 'cron',
    scheduleExpression: params.scheduleExpression,
    agentSlug: params.agentSlug,
  })

  return id
}

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Get a single scheduled task by ID
 */
export async function getScheduledTask(taskId: string): Promise<ScheduledTask | null> {
  const results = await db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, taskId))

  return results[0] || null
}

/**
 * List all scheduled tasks for an agent
 */
export async function listScheduledTasks(agentSlug: string): Promise<ScheduledTask[]> {
  return db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.agentSlug, agentSlug))
}

/**
 * List pending and paused scheduled tasks for an agent (i.e. everything still
 * on the schedule, whether actively firing or temporarily paused).
 */
export async function listPendingScheduledTasks(agentSlug: string): Promise<ScheduledTask[]> {
  return db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.agentSlug, agentSlug),
        inArray(scheduledTasks.status, ['pending', 'paused'])
      )
    )
}

/**
 * Batch version: list pending and paused scheduled tasks for multiple agents in a single query.
 * Returns a Map from agentSlug to array of ScheduledTask.
 */
export async function listPendingScheduledTasksByAgents(agentSlugs: string[]): Promise<Map<string, ScheduledTask[]>> {
  if (agentSlugs.length === 0) return new Map()

  const rows = await db
    .select()
    .from(scheduledTasks)
    .where(and(
      inArray(scheduledTasks.agentSlug, agentSlugs),
      inArray(scheduledTasks.status, ['pending', 'paused'])
    ))

  const result = new Map<string, ScheduledTask[]>()
  for (const row of rows) {
    let list = result.get(row.agentSlug)
    if (!list) { list = []; result.set(row.agentSlug, list) }
    list.push(row)
  }
  return result
}

/**
 * List cancelled recurring scheduled tasks for an agent (excludes one-time tasks)
 */
export async function listCancelledScheduledTasks(agentSlug: string): Promise<ScheduledTask[]> {
  return db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.agentSlug, agentSlug),
        eq(scheduledTasks.status, 'cancelled'),
        eq(scheduledTasks.scheduleType, 'cron')
      )
    )
}

/**
 * Get all tasks that are due for execution
 * (nextExecutionAt <= now and status = 'pending')
 */
export async function getDueTasks(): Promise<ScheduledTask[]> {
  return db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.status, 'pending'),
        lte(scheduledTasks.nextExecutionAt, new Date())
      )
    )
}

// ============================================================================
// Update Operations
// ============================================================================

/**
 * Cancel a scheduled task
 */
export async function cancelScheduledTask(taskId: string): Promise<boolean> {
  const result = await db
    .update(scheduledTasks)
    .set({
      status: 'cancelled',
      cancelledAt: new Date(),
    })
    .where(
      and(
        eq(scheduledTasks.id, taskId),
        inArray(scheduledTasks.status, ['pending', 'paused'])
      )
    )

  return (result.changes ?? 0) > 0
}

/**
 * Pause a recurring scheduled task. Paused tasks are not executed by the
 * scheduler. Resuming recomputes `nextExecutionAt` from the cron expression.
 */
export async function pauseScheduledTask(taskId: string): Promise<boolean> {
  const result = await db
    .update(scheduledTasks)
    .set({
      status: 'paused',
      pausedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledTasks.id, taskId),
        eq(scheduledTasks.status, 'pending'),
        eq(scheduledTasks.scheduleType, 'cron')
      )
    )

  return (result.changes ?? 0) > 0
}

/**
 * Resume a paused scheduled task. `nextExecutionAt` is recomputed from the
 * cron expression so missed executions are skipped.
 */
export async function resumeScheduledTask(taskId: string): Promise<boolean> {
  const task = await getScheduledTask(taskId)
  if (!task || task.status !== 'paused' || task.scheduleType !== 'cron') return false

  const nextExecutionAt = getNextCronTime(task.scheduleExpression, task.timezone || undefined)

  const result = await db
    .update(scheduledTasks)
    .set({
      status: 'pending',
      nextExecutionAt,
      pausedAt: null,
    })
    .where(eq(scheduledTasks.id, taskId))

  return (result.changes ?? 0) > 0
}

/**
 * Mark a one-time task as executed
 */
export async function markTaskExecuted(
  taskId: string,
  sessionId: string
): Promise<void> {
  await db
    .update(scheduledTasks)
    .set({
      status: 'executed',
      lastExecutedAt: new Date(),
      lastSessionId: sessionId,
      executionCount: 1,
    })
    .where(eq(scheduledTasks.id, taskId))
}

/**
 * Update next execution time for a recurring task
 */
export async function updateNextExecution(
  taskId: string,
  nextTime: Date,
  sessionId: string
): Promise<void> {
  const task = await getScheduledTask(taskId)
  if (!task) return

  await db
    .update(scheduledTasks)
    .set({
      nextExecutionAt: nextTime,
      lastExecutedAt: new Date(),
      lastSessionId: sessionId,
      executionCount: task.executionCount + 1,
    })
    .where(eq(scheduledTasks.id, taskId))
}

/**
 * Mark a task as failed
 */
export async function markTaskFailed(taskId: string, _error: string): Promise<void> {
  await db
    .update(scheduledTasks)
    .set({
      status: 'failed',
      lastExecutedAt: new Date(),
    })
    .where(eq(scheduledTasks.id, taskId))
}

/**
 * Reset a failed or cancelled task back to pending
 */
export async function resetScheduledTask(taskId: string): Promise<boolean> {
  const task = await getScheduledTask(taskId)
  if (!task) return false

  // Calculate next execution time (timezone-aware)
  const tz = task.timezone || undefined
  let nextExecutionAt: Date
  if (task.scheduleType === 'at') {
    // For 'at' tasks, use the original expression to recalculate
    nextExecutionAt = parseAtSyntax(task.scheduleExpression, tz)
  } else {
    nextExecutionAt = getNextCronTime(task.scheduleExpression, tz)
  }

  const result = await db
    .update(scheduledTasks)
    .set({
      status: 'pending',
      nextExecutionAt,
    })
    .where(eq(scheduledTasks.id, taskId))

  return (result.changes ?? 0) > 0
}

/**
 * Update a task's timezone and recalculate next execution time.
 */
export async function updateTaskTimezone(taskId: string, timezone: string): Promise<boolean> {
  const task = await getScheduledTask(taskId)
  if (!task || (task.status !== 'pending' && task.status !== 'paused')) return false

  const tz = timezone || undefined
  let nextExecutionAt: Date
  if (task.scheduleType === 'at') {
    nextExecutionAt = parseAtSyntax(task.scheduleExpression, tz)
  } else {
    nextExecutionAt = getNextCronTime(task.scheduleExpression, tz)
  }

  const result = await db
    .update(scheduledTasks)
    .set({ timezone, nextExecutionAt })
    .where(eq(scheduledTasks.id, taskId))

  return (result.changes ?? 0) > 0
}

// ============================================================================
// Delete Operations
// ============================================================================

/**
 * Update a recurring task's schedule expression and recalculate next execution time.
 */
export async function updateScheduleExpression(
  taskId: string,
  scheduleExpression: string
): Promise<boolean> {
  const task = await getScheduledTask(taskId)
  if (!task || task.status !== 'pending' || task.scheduleType !== 'cron') return false

  const tz = task.timezone || undefined
  const nextExecutionAt = getNextCronTime(scheduleExpression, tz)

  const result = await db
    .update(scheduledTasks)
    .set({ scheduleExpression, nextExecutionAt })
    .where(eq(scheduledTasks.id, taskId))

  return (result.changes ?? 0) > 0
}

/**
 * Record that a task was run manually (bump counts without changing schedule).
 */
export async function recordManualExecution(
  taskId: string,
  sessionId: string
): Promise<void> {
  const task = await getScheduledTask(taskId)
  if (!task) return

  await db
    .update(scheduledTasks)
    .set({
      lastExecutedAt: new Date(),
      lastSessionId: sessionId,
      executionCount: task.executionCount + 1,
    })
    .where(eq(scheduledTasks.id, taskId))
}

/**
 * Delete a scheduled task (hard delete)
 */
export async function deleteScheduledTask(taskId: string): Promise<boolean> {
  const result = await db
    .delete(scheduledTasks)
    .where(eq(scheduledTasks.id, taskId))

  return (result.changes ?? 0) > 0
}

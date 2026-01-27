/**
 * Scheduled Task Service
 *
 * Database operations for scheduled tasks.
 * Handles creating, listing, updating, and cancelling scheduled tasks.
 */

import { db } from '@shared/lib/db'
import { scheduledTasks, type ScheduledTask, type NewScheduledTask } from '@shared/lib/db/schema'
import { eq, and, lte } from 'drizzle-orm'
import { getNextCronTime, parseAtSyntax } from './schedule-parser'

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

  // Calculate next execution time based on schedule type
  let nextExecutionAt: Date
  if (params.scheduleType === 'at') {
    nextExecutionAt = parseAtSyntax(params.scheduleExpression)
  } else {
    nextExecutionAt = getNextCronTime(params.scheduleExpression)
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
  }

  await db.insert(scheduledTasks).values(newTask)

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
 * List pending scheduled tasks for an agent
 */
export async function listPendingScheduledTasks(agentSlug: string): Promise<ScheduledTask[]> {
  return db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.agentSlug, agentSlug),
        eq(scheduledTasks.status, 'pending')
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
        eq(scheduledTasks.status, 'pending')
      )
    )

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

  // Calculate next execution time
  let nextExecutionAt: Date
  if (task.scheduleType === 'at') {
    // For 'at' tasks, use the original expression to recalculate
    nextExecutionAt = parseAtSyntax(task.scheduleExpression)
  } else {
    nextExecutionAt = getNextCronTime(task.scheduleExpression)
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

// ============================================================================
// Delete Operations
// ============================================================================

/**
 * Delete a scheduled task (hard delete)
 */
export async function deleteScheduledTask(taskId: string): Promise<boolean> {
  const result = await db
    .delete(scheduledTasks)
    .where(eq(scheduledTasks.id, taskId))

  return (result.changes ?? 0) > 0
}

/**
 * Scheduled Task Service
 *
 * Database operations for scheduled tasks.
 * Handles creating, listing, updating, and cancelling scheduled tasks.
 */

import { db } from '@shared/lib/db'
import { scheduledTasks, type ScheduledTask, type NewScheduledTask } from '@shared/lib/db/schema'
import { eq, and, lte, inArray, isNotNull, isNull, desc } from 'drizzle-orm'
import { getNextCronTime, parseAtSyntax } from './schedule-parser'
import { trackServerEvent } from '../analytics/server-analytics'
import {
  openTargets,
  parseWakeOnSessions,
  serializeWakeOnSessions,
  type WakeOnSessions,
  type WakeOutcome,
  type WakeTarget,
} from './wake-on-sessions'

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
  createdByUserId?: string
  timezone?: string
  model?: string
  effort?: string
  speed?: string
  // When set, firing this task resumes the referenced session instead of
  // creating a new one. Prefer createSessionWake(), which also enforces the
  // one-pending-wake-per-session invariant.
  resumeSessionId?: string
}

export interface CreateSessionWakeParams {
  agentSlug: string
  // 'at' syntax expression, e.g. "at tomorrow 9am"
  scheduleExpression: string
  // Why the session is sleeping / what to check on wake — echoed back verbatim
  // in the wake message. Stored as the task prompt.
  note: string
  sessionId: string
  name?: string
  createdByUserId?: string
  timezone?: string
  // Absolute time, used instead of parsing scheduleExpression. Set when a
  // deferred timer is re-created after an event wake fired first.
  wakeAt?: Date
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
    createdByUserId: params.createdByUserId,
    timezone: params.timezone || null,
    model: params.model || null,
    effort: params.effort || null,
    speed: params.speed || null,
    resumeSessionId: params.resumeSessionId || null,
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

/**
 * Create a session wake: a one-shot task that resumes an existing session when
 * it fires. A session can hold at most one pending wake — creating a new one
 * cancels and replaces any existing pending wake for the same session, and the
 * replaced task is returned so callers can surface the swap.
 *
 * The schedule expression is validated BEFORE any mutation (a bad wakeTime
 * must never cancel the session's valid wake), and the cancel+insert pair runs
 * in a transaction so concurrent calls can't interleave into duplicate pending
 * wakes. A partial unique index on pending wakes backstops both.
 */
export async function createSessionWake(
  params: CreateSessionWakeParams
): Promise<{ taskId: string; replaced: ScheduledTask | null; merged: boolean }> {
  // Throws on unparseable/past expressions — before existing state is touched.
  const nextExecutionAt = params.wakeAt ?? parseAtSyntax(params.scheduleExpression, params.timezone || undefined)

  const id = crypto.randomUUID()
  const now = new Date()
  const newTask: NewScheduledTask = {
    id,
    agentSlug: params.agentSlug,
    scheduleType: 'at',
    scheduleExpression: params.scheduleExpression,
    prompt: params.note,
    name: params.name,
    status: 'pending',
    nextExecutionAt,
    isRecurring: false,
    executionCount: 0,
    createdAt: now,
    createdBySessionId: params.sessionId,
    createdByUserId: params.createdByUserId,
    timezone: params.timezone || null,
    resumeSessionId: params.sessionId,
  }

  // Synchronous better-sqlite3 transaction: read-existing → merge-or-cancel →
  // insert is one atomic unit, so no other caller can observe (or create) an
  // intermediate state.
  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.agentSlug, params.agentSlug),
          eq(scheduledTasks.resumeSessionId, params.sessionId),
          eq(scheduledTasks.status, 'pending')
        )
      )
      .all()

    // A row that lists invoked sessions keeps them, open or already finished:
    // the timer merges onto it, and whichever trigger comes first wakes the
    // session. Replacing it would drop a finished target's outcome that is
    // only waiting for the caller's turn to end.
    const waiting = existing.find((w) => {
      const wake = parseWakeOnSessions(w.wakeOnSessions)
      return wake !== null && wake.targets.length > 0
    })
    if (waiting) {
      tx.update(scheduledTasks)
        .set({
          scheduleType: 'at',
          scheduleExpression: params.scheduleExpression,
          prompt: params.note,
          nextExecutionAt,
          timezone: params.timezone || null,
        })
        .where(eq(scheduledTasks.id, waiting.id))
        .run()
      return { taskId: waiting.id, replaced: null, merged: true }
    }

    for (const wake of existing) {
      tx.update(scheduledTasks)
        .set({ status: 'cancelled', cancelledAt: now })
        .where(eq(scheduledTasks.id, wake.id))
        .run()
    }

    tx.insert(scheduledTasks).values(newTask).run()

    return { taskId: id, replaced: existing[0] ?? null, merged: false }
  })

  // A merge and a deferred-timer re-creation (wakeAt) are the same user
  // intent already counted once.
  if (!result.merged && !params.wakeAt) {
    trackServerEvent('task_scheduled', {
      scheduleType: 'at',
      isRecurring: false,
      scheduleExpression: params.scheduleExpression,
      agentSlug: params.agentSlug,
    })
  }

  return result
}

// ============================================================================
// Event wakes: a session wake that fires when invoked sessions finish
// ============================================================================

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

function pendingWakeRow(tx: Tx, agentSlug: string, sessionId: string): ScheduledTask | undefined {
  return tx
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.agentSlug, agentSlug),
        eq(scheduledTasks.resumeSessionId, sessionId),
        eq(scheduledTasks.status, 'pending')
      )
    )
    .get()
}

/**
 * Make a fully-settled row due now. A clock still in the future moves to
 * deferredTimerAt so delivery can re-create it afterwards.
 */
function makeDue(tx: Tx, row: ScheduledTask, wake: WakeOnSessions, now: Date): void {
  const deferredTimerAt =
    row.nextExecutionAt && row.nextExecutionAt.getTime() > now.getTime()
      ? row.nextExecutionAt.toISOString()
      : wake.deferredTimerAt
  tx.update(scheduledTasks)
    .set({
      nextExecutionAt: now,
      wakeOnSessions: serializeWakeOnSessions({ ...wake, deferredTimerAt }),
    })
    .where(eq(scheduledTasks.id, row.id))
    .run()
}

/**
 * Record that `sessionId` is waiting on `target`. Appends to the session's
 * pending wake (timer or event) or creates an event wake with no time.
 * Idempotent on an open target session id. A stamped target for the same
 * conversation is replaced so a second invoke waits for the new turn.
 */
export async function addWakeTarget(params: {
  agentSlug: string
  sessionId: string
  target: WakeTarget
  createdByUserId?: string
}): Promise<{ taskId: string }> {
  const now = new Date()
  return db.transaction((tx) => {
    const existing = pendingWakeRow(tx, params.agentSlug, params.sessionId)
    if (existing) {
      const wake = parseWakeOnSessions(existing.wakeOnSessions) ?? { targets: [] }
      const match = wake.targets.findIndex((t) => t.sessionId === params.target.sessionId)
      if (match === -1) {
        wake.targets.push(params.target)
        tx.update(scheduledTasks)
          .set({ wakeOnSessions: serializeWakeOnSessions(wake) })
          .where(eq(scheduledTasks.id, existing.id))
          .run()
        return { taskId: existing.id }
      }
      if (wake.targets[match].outcome === undefined) {
        return { taskId: existing.id }
      }
      wake.targets[match] = params.target
      let nextExecutionAt = existing.nextExecutionAt
      let { deferredTimerAt } = wake
      const due = nextExecutionAt !== null && nextExecutionAt.getTime() <= now.getTime()
      if (due) {
        if (deferredTimerAt) {
          nextExecutionAt = new Date(deferredTimerAt)
          deferredTimerAt = undefined
        } else {
          nextExecutionAt = null
        }
      }
      tx.update(scheduledTasks)
        .set({
          wakeOnSessions: serializeWakeOnSessions({ ...wake, deferredTimerAt }),
          nextExecutionAt,
        })
        .where(eq(scheduledTasks.id, existing.id))
        .run()
      return { taskId: existing.id }
    }

    const id = crypto.randomUUID()
    const newTask: NewScheduledTask = {
      id,
      agentSlug: params.agentSlug,
      scheduleType: 'event',
      scheduleExpression: '',
      prompt: '',
      status: 'pending',
      nextExecutionAt: null,
      isRecurring: false,
      executionCount: 0,
      createdAt: now,
      createdBySessionId: params.sessionId,
      createdByUserId: params.createdByUserId,
      resumeSessionId: params.sessionId,
      wakeOnSessions: serializeWakeOnSessions({ targets: [params.target] }),
    }
    tx.insert(scheduledTasks).values(newTask).run()
    return { taskId: id }
  })
}

/**
 * Pending session wakes that are waiting on invoked sessions.
 */
export async function listPendingEventWakes(): Promise<ScheduledTask[]> {
  return db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.status, 'pending'), isNotNull(scheduledTasks.wakeOnSessions)))
}

/**
 * Stamp `outcome` on every pending wake waiting on `targetSessionId`. Only
 * entries without an outcome change (first writer wins). A row whose entries
 * are now all stamped becomes due when its caller session is idle; otherwise
 * markWakeDueIfSettled makes it due on the caller's next idle.
 * Returns the ids of rows made due.
 */
export async function settleWakeTarget(params: {
  targetSessionId: string
  outcome: WakeOutcome
  callerIdle: (callerSessionId: string) => boolean
}): Promise<string[]> {
  return settleMatching((t) => t.sessionId === params.targetSessionId, params.outcome, params.callerIdle)
}

/**
 * Same as settleWakeTarget for every open target that belongs to one agent.
 * Used when the agent itself is deleted and none of its sessions will ever
 * emit a terminal event.
 */
export async function settleWakeTargetsForAgent(params: {
  targetAgentSlug: string
  outcome: WakeOutcome
  callerIdle: (callerSessionId: string) => boolean
}): Promise<string[]> {
  return settleMatching((t) => t.agentSlug === params.targetAgentSlug, params.outcome, params.callerIdle)
}

function settleMatching(
  matches: (target: WakeTarget) => boolean,
  outcome: WakeOutcome,
  callerIdle: (callerSessionId: string) => boolean,
): Promise<string[]> {
  const now = new Date()
  return Promise.resolve(
    db.transaction((tx) => {
      const rows = tx
        .select()
        .from(scheduledTasks)
        .where(and(eq(scheduledTasks.status, 'pending'), isNotNull(scheduledTasks.wakeOnSessions)))
        .all()
      const due: string[] = []
      for (const row of rows) {
        const wake = parseWakeOnSessions(row.wakeOnSessions)
        if (!wake || !row.resumeSessionId) continue
        const entries = wake.targets.filter((t) => matches(t) && t.outcome === undefined)
        if (entries.length === 0) continue
        for (const entry of entries) entry.outcome = outcome
        tx.update(scheduledTasks)
          .set({ wakeOnSessions: serializeWakeOnSessions(wake) })
          .where(eq(scheduledTasks.id, row.id))
          .run()
        if (openTargets(wake).length === 0 && callerIdle(row.resumeSessionId)) {
          makeDue(tx, row, wake, now)
          due.push(row.id)
        }
      }
      return due
    }),
  )
}

/**
 * Called when a caller session goes idle: if its pending wake has every target
 * stamped, make it due now. Returns true when the row is due after this call
 * (just made, or already due from a caller-busy holdoff).
 */
export async function markWakeDueIfSettled(callerSessionId: string): Promise<boolean> {
  const now = new Date()
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.resumeSessionId, callerSessionId),
          eq(scheduledTasks.status, 'pending'),
          isNotNull(scheduledTasks.wakeOnSessions)
        )
      )
      .get()
    if (!row) return false
    const wake = parseWakeOnSessions(row.wakeOnSessions)
    if (!wake || wake.targets.length === 0 || openTargets(wake).length > 0) return false
    if (row.nextExecutionAt && row.nextExecutionAt.getTime() <= now.getTime()) return true
    makeDue(tx, row, wake, now)
    return true
  })
}

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Get the pending wake for a session, if any. There is at most one — the
 * one-pending-wake-per-session invariant is enforced by createSessionWake.
 */
export async function getPendingWakeForSession(
  agentSlug: string,
  sessionId: string
): Promise<ScheduledTask | null> {
  const results = await db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.agentSlug, agentSlug),
        eq(scheduledTasks.resumeSessionId, sessionId),
        eq(scheduledTasks.status, 'pending')
      )
    )

  return results[0] || null
}

/**
 * List all pending session wakes for an agent (tasks that resume an existing
 * session rather than create a new one).
 */
export async function listPendingWakesByAgent(agentSlug: string): Promise<ScheduledTask[]> {
  return db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.agentSlug, agentSlug),
        isNotNull(scheduledTasks.resumeSessionId),
        eq(scheduledTasks.status, 'pending')
      )
    )
}

/**
 * Session ids with a pending wake for an agent. Used by cleanup paths (e.g.
 * auto-delete) that must not destroy a session scheduled to resume.
 */
export async function listSessionIdsWithPendingWakes(agentSlug: string): Promise<Set<string>> {
  const wakes = await listPendingWakesByAgent(agentSlug)
  return new Set(wakes.map((w) => w.resumeSessionId!))
}

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
 * List one-time scheduled tasks that have fired and created a standalone
 * session. Session wakes are excluded: they resume an existing interactive
 * session and are surfaced on that session instead of in automation history.
 */
export async function listCompletedOneTimeTasks(agentSlug: string): Promise<ScheduledTask[]> {
  return db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.agentSlug, agentSlug),
        eq(scheduledTasks.scheduleType, 'at'),
        eq(scheduledTasks.status, 'executed'),
        isNull(scheduledTasks.resumeSessionId),
        isNotNull(scheduledTasks.lastSessionId)
      )
    )
    .orderBy(desc(scheduledTasks.lastExecutedAt))
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
 * Cancel the pending wake targeting a session, if any. Called when the session
 * is deleted so the scheduler never fires a wake at a session that's gone.
 */
export async function cancelPendingWakeForSession(
  agentSlug: string,
  sessionId: string
): Promise<boolean> {
  const wake = await getPendingWakeForSession(agentSlug, sessionId)
  if (!wake) return false
  return cancelScheduledTask(wake.id)
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
  // Event wakes have no clock to recompute; they become due when their targets finish.
  if (task.scheduleType === 'event') return false

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
  // Event wakes have no clock to recompute; they become due when their targets finish.
  if (task.scheduleType === 'event') return false

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
 * Update a scheduled task's prompt (the instructions executed when the task runs).
 * Allowed for pending or paused tasks.
 */
export async function updateTaskPrompt(
  taskId: string,
  prompt: string,
): Promise<boolean> {
  const task = await getScheduledTask(taskId)
  if (!task || (task.status !== 'pending' && task.status !== 'paused')) return false

  const result = await db
    .update(scheduledTasks)
    .set({ prompt })
    .where(eq(scheduledTasks.id, taskId))

  return (result.changes ?? 0) > 0
}

/**
 * Update a scheduled task's display name.
 * Allowed for pending or paused tasks.
 */
export async function updateTaskName(
  taskId: string,
  name: string,
): Promise<boolean> {
  const task = await getScheduledTask(taskId)
  if (!task || (task.status !== 'pending' && task.status !== 'paused')) return false

  const result = await db
    .update(scheduledTasks)
    .set({ name })
    .where(eq(scheduledTasks.id, taskId))

  return (result.changes ?? 0) > 0
}

/**
 * Update a recurring task's schedule expression and recalculate next execution time.
 */
export async function updateScheduleExpression(
  taskId: string,
  scheduleExpression: string
): Promise<boolean> {
  const task = await getScheduledTask(taskId)
  if (
    !task ||
    (task.status !== 'pending' && task.status !== 'paused') ||
    task.scheduleType !== 'cron'
  )
    return false

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
 * Update a task's runtime options (model, effort, and/or speed).
 * Pass null to clear a field back to the global default.
 */
export async function updateTaskRuntimeOptions(
  taskId: string,
  options: { model?: string | null; effort?: string | null; speed?: string | null },
): Promise<boolean> {
  const task = await getScheduledTask(taskId)
  if (!task || (task.status !== 'pending' && task.status !== 'paused')) return false

  const updates: Record<string, string | null> = {}
  if ('model' in options) updates.model = options.model ?? null
  if ('effort' in options) updates.effort = options.effort ?? null
  if ('speed' in options) updates.speed = options.speed ?? null

  const result = await db
    .update(scheduledTasks)
    .set(updates)
    .where(eq(scheduledTasks.id, taskId))

  return (result.changes ?? 0) > 0
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

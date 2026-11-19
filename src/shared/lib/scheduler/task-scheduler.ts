/**
 * Task Scheduler
 *
 * Executes scheduled tasks at their due times: one-time ('at') and recurring
 * ('cron') tasks, and session wakes.
 *
 * The schedule records in the database are the authority. Each pending one has a
 * local wakeup on the TaskManager, set from its record at startup and whenever a
 * write moves it (`syncScheduleWakeup`). A wakeup only says "look at this record
 * now": it is the record that decides what happens, so a stale wakeup does no
 * harm, and a record still pending is never left without one.
 */

import pLimit from 'p-limit'
import { agentRegistry } from '@shared/lib/agent-actor'
import type { AgentActor } from '@shared/lib/agent-actor'
import { getSettings } from '@shared/lib/config/settings'
import { resolveSessionDefaults } from '@shared/lib/services/session-defaults'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { runWithOptionalUser } from '@shared/lib/platform-attribution'
import {
  getDueTasks,
  getScheduledTask,
  listPendingScheduledTaskIds,
  markTaskExecuted,
  markTaskFailed,
  recordTaskSkip,
  rescheduleAfterFailure,
  syncScheduleWakeup,
  updateNextExecution,
} from '@shared/lib/services/scheduled-task-service'
import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'
import { getNextCronTime } from '@shared/lib/services/schedule-parser'
import { getSecretEnvVars } from '@shared/lib/services/secrets-service'
import { agentExists } from '@shared/lib/services/agent-service'
import { captureException } from '@shared/lib/error-reporting'
import { background } from '@shared/lib/background'
import { PassTask, Task, taskManager, type Service, type TaskContext, type TaskResult } from '@shared/lib/background-work'
import { AGENT_CRON_TASK_TYPE, agentCronPayloadSchema, type AgentCronPayload } from './agent-cron-schema'
import { deliverSessionWake } from './wake-delivery'

/**
 * How soon a task that is still due is looked at again: one held by its previous
 * run, a wake that failed or is being delivered elsewhere, or a record that could
 * not be read. It is also the least a recurring task waits between fires, so a
 * cron with a seconds field fires at most once a minute.
 */
const RECHECK_MS = 60_000

/** How far short of a minute a recurring fire can be and still keep its cron time: the time its wakeup took to run. */
const FIRE_SPACING_TOLERANCE_MS = 5_000

/**
 * How long an overdue session wake keeps retrying (via its wakeup)
 * before being marked failed. Unlike regular one-shot tasks, a wake may be
 * days in the making — a transient failure at fire time (runtime restarting,
 * machine waking from sleep) must not permanently kill it.
 */
const WAKE_RETRY_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * Whether a recurring task's previous run still occupies its slot: busy and not
 * parked on user input. A parked run has nobody to answer it, so it frees the
 * slot; a run whose turn ended with background work still going stays active
 * and keeps it.
 */
async function isRunBusy(actor: AgentActor, sessionId: string): Promise<boolean> {
  const live = await actor.sessions.live(sessionId)
  return live.isActive && !live.isAwaitingInput
}

/** What became of a task that came due. */
type DueTaskOutcome =
  /** Nothing further is scheduled: it was executed, or failed. */
  | { kind: 'finished' }
  /** It stays due, its time unchanged: look again soon. */
  | { kind: 'held' }
  /** A recurring task, moved to its next time. */
  | { kind: 'rescheduled'; nextTime: Date }

/** One schedule's wakeup. One class for every schedule, told apart by payload. */
class AgentCronTask extends Task<AgentCronPayload> {
  readonly type = AGENT_CRON_TASK_TYPE
  readonly payloadSchema = agentCronPayloadSchema

  constructor(private readonly wake: (payload: AgentCronPayload, ctx: TaskContext) => Promise<TaskResult<AgentCronPayload>>) {
    super()
  }

  execute(payload: AgentCronPayload, ctx: TaskContext): Promise<TaskResult<AgentCronPayload>> {
    return this.wake(payload, ctx)
  }
}

class TaskScheduler implements Service {
  readonly id = 'task-scheduler'
  readonly phase = 'background' as const
  readonly startupIo = true
  private isRunning = false
  // One at a time across all schedules, to avoid overwhelming the system: each
  // can boot a container, and many can come due in the same moment.
  private readonly oneAtATime = pLimit(1)
  private readonly cronTask = new AgentCronTask((payload, ctx) => this.onWakeup(payload, ctx))
  private readonly rebuildTask = new PassTask('agent.cron-rebuild', () => this.rebuildWakeups())
  readonly tasks = [this.cronTask, this.rebuildTask]

  /**
   * Start the scheduler: every pending schedule gets its wakeup. One already due
   * came due while the app was closed, and fires now.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[TaskScheduler] Already running')
      return
    }

    // Before the records are read: a write from here on sets its own wakeup.
    this.isRunning = true
    console.log('[TaskScheduler] Starting scheduler...')
    await this.rebuildWakeups()
    console.log('[TaskScheduler] Scheduler started')
  }

  /**
   * Stop the scheduler. The schedules stay as they are in the database, for the
   * next start. A wakeup still set finds the scheduler stopped and does nothing.
   */
  stop(): void {
    background(taskManager().cancel(this.rebuildTask.type), { name: 'task-scheduler.cancel-rebuild' })
    this.isRunning = false
    console.log('[TaskScheduler] Scheduler stopped')
  }

  /**
   * Check if the scheduler is running.
   */
  isActive(): boolean {
    return this.isRunning
  }

  /**
   * Set a wakeup for every pending schedule, from its record. A failure is
   * non-fatal (a SQLite hiccup, SUP-224): it is reported and tried again, and
   * startup is not wedged.
   */
  private async rebuildWakeups(): Promise<void> {
    if (!this.isRunning) return
    try {
      for (const id of await listPendingScheduledTaskIds()) await syncScheduleWakeup(id)
    } catch (error) {
      console.error('[TaskScheduler] Could not set the schedule wakeups; trying again:', error)
      captureException(error, { tags: { component: 'task-scheduler', phase: 'initial-scan' } })
      await taskManager().at(Date.now() + RECHECK_MS, this.rebuildTask.type, this.rebuildTask.spec)
    }
  }

  /**
   * A schedule's wakeup came due: the record decides what happens. Whatever goes
   * wrong, a record that may still be pending gets another look.
   */
  private onWakeup(payload: AgentCronPayload, ctx: TaskContext): Promise<TaskResult<AgentCronPayload>> {
    return this.oneAtATime(async () => {
      // Dispatch stopped, or the wakeup was cancelled, while it waited its turn.
      if (ctx.signal.aborted || !this.isRunning) return { kind: 'done' }
      const firedAt = ctx.now()
      try {
        const task = await getScheduledTask(payload.scheduleId)
        if (task?.status !== 'pending') return { kind: 'done' }
        // It moved after this wakeup was set: wake again when the record says.
        if (task.nextExecutionAt.getTime() > firedAt) return this.nextWakeup(task.id, task.nextExecutionAt.getTime(), task.nextExecutionAt.getTime())

        const outcome = await this.executeDueTask(task)
        switch (outcome.kind) {
          case 'finished':
            return { kind: 'done' }
          case 'held':
            return { kind: 'retry', at: ctx.now() + RECHECK_MS }
          case 'rescheduled': {
            const scheduledFor = outcome.nextTime.getTime()
            // A wakeup can only come back so soon for a cron with a seconds field.
            const tooSoon = scheduledFor < firedAt + RECHECK_MS - FIRE_SPACING_TOLERANCE_MS
            return this.nextWakeup(task.id, scheduledFor, tooSoon ? firedAt + RECHECK_MS : scheduledFor)
          }
        }
      } catch (error) {
        console.error(`[TaskScheduler] Could not act on schedule ${payload.scheduleId}; looking again in a minute:`, error)
        captureException(error, { tags: { component: 'task-scheduler', phase: 'poll' }, extra: { taskId: payload.scheduleId } })
        return { kind: 'retry', at: ctx.now() + RECHECK_MS }
      }
    })
  }

  private nextWakeup(scheduleId: string, scheduledFor: number, at: number): TaskResult<AgentCronPayload> {
    return { kind: 'next', at, payload: { scheduleId, scheduledFor } }
  }

  /**
   * Execute a task that is due, deciding what a failure means for it.
   */
  private async executeDueTask(task: ScheduledTask): Promise<DueTaskOutcome> {
    try {
      // Attribute to task creator (baked into ANTHROPIC token on cold start).
      return await runWithOptionalUser(task.createdByUserId, () => this.executeTaskInner(task))
    } catch (error) {
      console.error(
        `[TaskScheduler] Failed to execute task ${task.id}:`,
        error
      )
      captureException(error, {
        tags: { component: 'task-scheduler', phase: 'execute-task' },
        extra: { taskId: task.id, agentSlug: task.agentSlug, isRecurring: task.isRecurring },
      })
      // For recurring tasks, schedule the next attempt without recording an
      // execution: lastSessionId keeps pointing at the previous run so the
      // overlap guard stays armed. For one-time tasks, mark as failed.
      if (!task.isRecurring && task.resumeSessionId &&
          Date.now() - task.nextExecutionAt.getTime() < WAKE_RETRY_WINDOW_MS) {
        // Session wakes stay pending on transient failure so their wakeup retries
        // them; they only fail once overdue past the retry window.
        console.log(
          `[TaskScheduler] Wake ${task.id} failed transiently; leaving pending for retry`
        )
        return { kind: 'held' }
      }
      if (task.isRecurring) {
        try {
          const nextTime = getNextCronTime(task.scheduleExpression, task.timezone || undefined)
          await rescheduleAfterFailure(task.id, nextTime)
          console.log(
            `[TaskScheduler] Recurring task ${task.id} failed but scheduled next: ${nextTime.toISOString()}`
          )
          return { kind: 'rescheduled', nextTime }
        } catch (scheduleError) {
          console.error(
            `[TaskScheduler] Failed to schedule next execution for ${task.id}:`,
            scheduleError
          )
        }
      }
      try {
        await markTaskFailed(task.id, String(error))
        return { kind: 'finished' }
      } catch (markError) {
        // Still pending and due, so it gets another look.
        console.error(markError)
        return { kind: 'held' }
      }
    }
  }

  private async executeTaskInner(task: ScheduledTask): Promise<DueTaskOutcome> {
    console.log(
      `[TaskScheduler] Executing task ${task.id} for agent ${task.agentSlug}`
    )

    if (task.resumeSessionId) {
      return this.executeSessionWake(task, task.resumeSessionId)
    }

    const actor = agentRegistry.get(task.agentSlug)

    const existingSession = await actor.sessions.forScheduledExecution(task.id, task.nextExecutionAt)

    if (existingSession) {
      console.log(
        `[TaskScheduler] Task ${task.id} already has session ${existingSession.id}; reconciling task status`
      )
      return this.recordTaskExecution(task, existingSession.id)
    }

    // Overlap guard: while the previous run of this recurring task is still
    // busy, hold this fire rather than start a second concurrent session.
    // Holding leaves nextExecutionAt alone: the task stays due, each look
    // re-checks, and the first free look fires once and re-anchors to the next
    // cron boundary. One scalar means at most one pending fire per task.
    if (task.isRecurring && task.lastSessionId && await isRunBusy(actor, task.lastSessionId)) {
      console.log(
        `[TaskScheduler] Task ${task.id} held: previous run ${task.lastSessionId} is still busy`
      )
      // A hold is not a failure: a failed skip write must not reach the failure
      // path, which would advance the schedule and drop the held fire.
      await recordTaskSkip(task.id).catch((error) => {
        console.error(`[TaskScheduler] Failed to record skip for task ${task.id}:`, error)
        captureException(error, {
          tags: { component: 'task-scheduler', phase: 'record-skip' },
          extra: { taskId: task.id, agentSlug: task.agentSlug },
        })
      })
      return { kind: 'held' }
    }

    // Verify agent still exists
    if (!(await agentExists(task.agentSlug))) {
      console.error(
        `[TaskScheduler] Agent ${task.agentSlug} no longer exists, marking task as failed`
      )
      await markTaskFailed(task.id, 'Agent no longer exists')
      return { kind: 'finished' }
    }

    // Start the container if not running
    await actor.container.start()

    // Get available env vars for the agent
    const availableEnvVars = await getSecretEnvVars(task.agentSlug)

    // Create a new session with the scheduled prompt, from one read of the
    // settings for this execution (the next one reads its own).
    // Model/effort/speed preference order: task override > agent default > global default.
    const { models, resolve } = await resolveSessionDefaults(await getSettings(), task.agentSlug)
    const resolved = await resolve({ model: task.model, llmProviderId: task.llmProviderId, effort: task.effort, speed: task.speed })
    const { id: sessionId } = await actor.sessions.start({
      create: {
        availableEnvVars:
          availableEnvVars.length > 0 ? availableEnvVars : undefined,
        initialMessage: task.prompt,
        model: resolved.model,
        llmProviderId: resolved.llmProviderId,
        browserModel: models.browserModel,
        dashboardBuilderModel: models.dashboardBuilderModel,
        metadata: { isAutomated: true },
        effort: resolved.effort,
        ...(resolved.speed ? { speed: resolved.speed } : {}),
      },
      name: task.name || 'Scheduled Task',
      metadata: {
        isScheduledExecution: true,
        scheduledTaskId: task.id,
        scheduledTaskName: task.name || undefined,
        scheduledExecutionAt: task.nextExecutionAt.toISOString(),
        automationStatus: 'running',
      },
    })

    console.log(
      `[TaskScheduler] Task ${task.id} started, session: ${sessionId}`
    )

    // Trigger scheduled session started notification
    background(notificationManager.triggerScheduledSessionStarted(
      sessionId,
      task.agentSlug,
      task.id,
      task.name || undefined
    ).catch((err) => {
      console.error('[TaskScheduler] Failed to trigger scheduled notification:', err)
    }), { name: 'task-scheduler.notify-session-started' })

    return this.recordTaskExecution(task, sessionId)
  }

  /**
   * Fire a session wake: resume the existing target session with a system
   * message instead of creating a new session. Delivery (claim, guards, send,
   * record) lives in deliverSessionWake, shared with the manual "Wake now"
   * route so the two paths can never double-deliver. Transient delivery
   * errors propagate to the caller's retry handling.
   */
  private async executeSessionWake(task: ScheduledTask, sessionId: string): Promise<DueTaskOutcome> {
    const result = await deliverSessionWake(task, 'scheduled')

    switch (result.outcome) {
      case 'delivered':
        console.log(`[TaskScheduler] Wake ${task.id} resumed session ${sessionId}`)
        return { kind: 'finished' }
      case 'reconciled':
        console.log(
          `[TaskScheduler] Wake ${task.id} already delivered to session ${sessionId}; reconciled task status`
        )
        return { kind: 'finished' }
      case 'in-flight':
        // Another delivery (e.g. a "Wake now" click) holds the claim — its
        // completion records the execution; a look later finds it done, or
        // tries again if that delivery failed.
        console.log(`[TaskScheduler] Wake ${task.id} delivery already in flight; skipping`)
        return { kind: 'held' }
      case 'not-pending':
        // Fresh read shows the task already reached a terminal state (a manual
        // wake won the race) — the due-task batch was just stale.
        console.log(`[TaskScheduler] Wake ${task.id} is ${result.status}; skipping`)
        return { kind: 'finished' }
      case 'session-missing':
        console.error(
          `[TaskScheduler] Wake ${task.id} target session ${sessionId} no longer exists`
        )
        await markTaskFailed(task.id, 'Session no longer exists')
        return { kind: 'finished' }
      case 'agent-missing':
        console.error(
          `[TaskScheduler] Agent ${task.agentSlug} no longer exists, marking wake as failed`
        )
        await markTaskFailed(task.id, 'Agent no longer exists')
        return { kind: 'finished' }
    }
  }

  private async recordTaskExecution(task: ScheduledTask, sessionId: string): Promise<DueTaskOutcome> {
    if (task.isRecurring) {
      // Update next execution time for recurring tasks
      const nextTime = getNextCronTime(task.scheduleExpression, task.timezone || undefined)
      await updateNextExecution(task.id, nextTime, sessionId)
      console.log(
        `[TaskScheduler] Recurring task ${task.id} next execution: ${nextTime.toISOString()}`
      )
      return { kind: 'rescheduled', nextTime }
    }
    // Mark one-time task as executed
    await markTaskExecuted(task.id, sessionId)
    console.log(`[TaskScheduler] One-time task ${task.id} marked as executed`)
    return { kind: 'finished' }
  }

  /**
   * Execute whatever is due now, one at a time, without waiting for a wakeup (for testing).
   */
  async triggerExecution(): Promise<void> {
    for (const task of await getDueTasks()) await this.executeDueTask(task)
  }
}

// Export singleton instance
// Use globalThis to persist across hot reloads in development
const globalForScheduler = globalThis as unknown as {
  taskScheduler: TaskScheduler | undefined
}

export const taskScheduler =
  globalForScheduler.taskScheduler ?? new TaskScheduler()

if (process.env.NODE_ENV !== 'production') {
  globalForScheduler.taskScheduler = taskScheduler
}

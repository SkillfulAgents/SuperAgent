/**
 * Task Scheduler
 *
 * Background process that executes scheduled tasks at their due times.
 * Handles both one-time ('at') and recurring ('cron') tasks.
 */

import { containerManager } from '@shared/lib/container/container-manager'
import { getEffectiveModels } from '@shared/lib/config/settings'
import { messagePersister } from '@shared/lib/container/message-persister'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { runWithOptionalUser } from '@shared/lib/platform-attribution'
import {
  getDueTasks,
  markTaskExecuted,
  markTaskFailed,
  recordTaskSkip,
  rescheduleAfterFailure,
  updateNextExecution,
} from '@shared/lib/services/scheduled-task-service'
import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'
import type { EffortLevel } from '@shared/lib/container/types'
import { getNextCronTime } from '@shared/lib/services/schedule-parser'
import {
  getSessionForScheduledExecution,
  registerSession,
} from '@shared/lib/services/session-service'
import { getSecretEnvVars } from '@shared/lib/services/secrets-service'
import { agentExists } from '@shared/lib/services/agent-service'
import { captureException } from '@shared/lib/error-reporting'


class TaskScheduler {
  private intervalId: NodeJS.Timeout | null = null
  private isRunning = false
  private pollIntervalMs = 60000 // Check every minute
  private isProcessing = false // Prevent concurrent execution

  /**
   * Start the scheduler.
   * Will immediately check for overdue tasks and then poll periodically.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[TaskScheduler] Already running')
      return
    }

    this.isRunning = true
    console.log('[TaskScheduler] Starting scheduler...')

    // Install the periodic poll loop FIRST, unconditionally. The poll loop is
    // the scheduler's natural retry: it re-scans every interval and is the same
    // code path that runs in steady state. Installing it before the immediate
    // catch-up scan means a transient failure in that scan (e.g. a SQLite hiccup
    // in getDueTasks — SUP-224) can no longer prevent polling from running, so
    // the scheduler self-heals on the next tick instead of wedging.
    this.intervalId = setInterval(() => {
      this.executeOverdueTasks().catch((error) => {
        console.error('[TaskScheduler] Error in polling cycle:', error)
        captureException(error, { tags: { component: 'task-scheduler', phase: 'poll' } })
      })
    }, this.pollIntervalMs)

    console.log(
      `[TaskScheduler] Scheduler started, polling every ${this.pollIntervalMs / 1000}s`
    )

    // Best-effort immediate catch-up scan so overdue tasks run now rather than
    // waiting up to one poll interval. A failure here is non-fatal: report it and
    // let the poll loop above retry — startup is NOT wedged and isActive() stays
    // true.
    try {
      await this.executeOverdueTasks()
    } catch (error) {
      console.error('[TaskScheduler] Initial overdue scan failed; poll loop will retry:', error)
      captureException(error, { tags: { component: 'task-scheduler', phase: 'initial-scan' } })
    }
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
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
   * Execute all tasks that are due.
   */
  private async executeOverdueTasks(): Promise<void> {
    // Prevent concurrent execution
    if (this.isProcessing) {
      console.log('[TaskScheduler] Already processing, skipping this cycle')
      return
    }

    this.isProcessing = true

    try {
      const dueTasks = await getDueTasks()

      if (dueTasks.length === 0) {
        return
      }

      console.log(`[TaskScheduler] Found ${dueTasks.length} due task(s)`)

      // Execute tasks sequentially to avoid overwhelming the system
      for (const task of dueTasks) {
        try {
          await this.executeTask(task)
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
          // execution: rescheduleAfterFailure advances nextExecutionAt only,
          // preserving lastSessionId (blanking it would disarm the overlap
          // guard) and the consecutiveSkips hold streak.
          // For one-time tasks, mark as failed.
          if (task.isRecurring) {
            try {
              const nextTime = getNextCronTime(task.scheduleExpression, task.timezone || undefined)
              await rescheduleAfterFailure(task.id, nextTime)
              console.log(
                `[TaskScheduler] Recurring task ${task.id} failed but scheduled next: ${nextTime.toISOString()}`
              )
            } catch (scheduleError) {
              console.error(
                `[TaskScheduler] Failed to schedule next execution for ${task.id}:`,
                scheduleError
              )
              await markTaskFailed(task.id, String(error)).catch(console.error)
            }
          } else {
            await markTaskFailed(task.id, String(error)).catch(console.error)
          }
        }
      }
    } finally {
      this.isProcessing = false
    }
  }

  /**
   * Execute a single scheduled task.
   */
  private async executeTask(task: ScheduledTask): Promise<void> {
    // Attribute to task creator (baked into ANTHROPIC token on cold start).
    return runWithOptionalUser(task.createdByUserId, () => this.executeTaskInner(task))
  }

  private async executeTaskInner(task: ScheduledTask): Promise<void> {
    console.log(
      `[TaskScheduler] Executing task ${task.id} for agent ${task.agentSlug}`
    )

    const existingSession = await getSessionForScheduledExecution(
      task.agentSlug,
      task.id,
      task.nextExecutionAt,
    )

    if (existingSession) {
      console.log(
        `[TaskScheduler] Task ${task.id} already has session ${existingSession.id}; reconciling task status`
      )
      await this.recordTaskExecution(task, existingSession.id)
      return
    }

    // Per-task overlap guard (recurring crons only): if the previous run of THIS
    // task is still actively progressing, hold this fire instead of spawning a
    // second concurrent session. "Actively progressing" means busy AND not parked
    // on user input — a parked run has nobody to answer an offline scheduled
    // question, so it must not wedge the task forever, whereas a run with a
    // backgrounded task still executing stays isActive=true / isAwaitingInput=false
    // and correctly counts as occupied.
    //
    // Hold semantics: we do NOT advance nextExecutionAt, leaving the task due so
    // the next poll re-checks and fires the freshest run the moment the slot frees
    // (re-anchoring forward via getNextCronTime(now) in recordTaskExecution).
    // Because nextExecutionAt is a single scalar, at most one pending fire exists
    // per task — coalesce-to-latest is automatic. Each held cycle bumps
    // consecutiveSkips / lastSkippedAt for skip observability.
    if (task.isRecurring && task.lastSessionId) {
      const lastSessionId = task.lastSessionId
      const occupied =
        messagePersister.isSessionActive(lastSessionId) &&
        !messagePersister.isSessionAwaitingInput(lastSessionId)
      if (occupied) {
        console.log(
          `[TaskScheduler] Task ${task.id} held: previous run ${lastSessionId} still active; leaving task due`
        )
        // Best-effort bookkeeping: a hold is not a failure, so a failed skip
        // write must not escape into the failure path (which would advance the
        // schedule and abandon the pending fire). Report and hold regardless.
        try {
          await recordTaskSkip(task.id)
        } catch (error) {
          console.error(
            `[TaskScheduler] Failed to record skip for task ${task.id}:`,
            error
          )
          captureException(error, {
            tags: { component: 'task-scheduler', phase: 'record-skip' },
            extra: { taskId: task.id, agentSlug: task.agentSlug },
          })
        }
        return
      }
    }

    // Verify agent still exists
    if (!(await agentExists(task.agentSlug))) {
      console.error(
        `[TaskScheduler] Agent ${task.agentSlug} no longer exists, marking task as failed`
      )
      await markTaskFailed(task.id, 'Agent no longer exists')
      return
    }

    // Start the container if not running
    const client = await containerManager.ensureRunning(task.agentSlug)

    // Get available env vars for the agent
    const availableEnvVars = await getSecretEnvVars(task.agentSlug)

    // Create a new session with the scheduled prompt
    const models = getEffectiveModels()
    const containerSession = await client.createSession({
      availableEnvVars:
        availableEnvVars.length > 0 ? availableEnvVars : undefined,
      initialMessage: task.prompt,
      model: task.model || models.agentModel,
      browserModel: models.browserModel,
      dashboardBuilderModel: models.dashboardBuilderModel,
      metadata: { isAutomated: true },
      ...(task.effort ? { effort: task.effort as EffortLevel } : {}),
    })

    const sessionId = containerSession.id
    const sessionName = task.name || 'Scheduled Task'

    try {
      await registerSession(task.agentSlug, sessionId, sessionName, {
        isScheduledExecution: true,
        scheduledTaskId: task.id,
        scheduledTaskName: task.name || undefined,
        scheduledExecutionAt: task.nextExecutionAt.toISOString(),
      })

      // Subscribe to the session for SSE updates
      await messagePersister.subscribeToSession(
        sessionId,
        client,
        sessionId,
        task.agentSlug
      )
      messagePersister.markSessionActive(sessionId, task.agentSlug)
    } catch (error) {
      // The session already exists and is executing the prompt (initialMessage),
      // even though registration/subscription failed. Record it as this fire's
      // session before propagating so the schedule advances pointing at the real
      // session — arming the overlap guard against the orphan — instead of going
      // through the failure path, which records no session at all.
      await this.recordTaskExecution(task, sessionId).catch((recordError) => {
        console.error(
          `[TaskScheduler] Failed to record orphaned session ${sessionId} for task ${task.id}:`,
          recordError
        )
        captureException(recordError, {
          tags: { component: 'task-scheduler', phase: 'record-orphan' },
          extra: { taskId: task.id, agentSlug: task.agentSlug, sessionId },
        })
      })
      throw error
    }

    console.log(
      `[TaskScheduler] Task ${task.id} started, session: ${sessionId}`
    )

    // Trigger scheduled session started notification
    notificationManager.triggerScheduledSessionStarted(
      sessionId,
      task.agentSlug,
      task.id,
      task.name || undefined
    ).catch((err) => {
      console.error('[TaskScheduler] Failed to trigger scheduled notification:', err)
    })

    await this.recordTaskExecution(task, sessionId)
  }

  private async recordTaskExecution(task: ScheduledTask, sessionId: string): Promise<void> {
    if (task.isRecurring) {
      // Update next execution time for recurring tasks
      const nextTime = getNextCronTime(task.scheduleExpression, task.timezone || undefined)
      await updateNextExecution(task.id, nextTime, sessionId)
      console.log(
        `[TaskScheduler] Recurring task ${task.id} next execution: ${nextTime.toISOString()}`
      )
    } else {
      // Mark one-time task as executed
      await markTaskExecuted(task.id, sessionId)
      console.log(`[TaskScheduler] One-time task ${task.id} marked as executed`)
    }
  }

  /**
   * Manually trigger execution of due tasks (for testing).
   */
  async triggerExecution(): Promise<void> {
    await this.executeOverdueTasks()
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

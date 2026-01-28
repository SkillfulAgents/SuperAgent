/**
 * Task Scheduler
 *
 * Background process that executes scheduled tasks at their due times.
 * Handles both one-time ('at') and recurring ('cron') tasks.
 */

import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import {
  getDueTasks,
  markTaskExecuted,
  markTaskFailed,
  updateNextExecution,
} from '@shared/lib/services/scheduled-task-service'
import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'
import { getNextCronTime } from '@shared/lib/services/schedule-parser'
import {
  registerSession,
  updateSessionMetadata,
} from '@shared/lib/services/session-service'
import { getSecretEnvVars } from '@shared/lib/services/secrets-service'
import { agentExists } from '@shared/lib/services/agent-service'


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

    // Execute overdue tasks immediately on startup
    await this.executeOverdueTasks()

    // Start periodic polling
    this.intervalId = setInterval(() => {
      this.executeOverdueTasks().catch((error) => {
        console.error('[TaskScheduler] Error in polling cycle:', error)
      })
    }, this.pollIntervalMs)

    console.log(
      `[TaskScheduler] Scheduler started, polling every ${this.pollIntervalMs / 1000}s`
    )
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
          // For recurring tasks, schedule next execution even on failure
          // For one-time tasks, mark as failed
          if (task.isRecurring) {
            try {
              const nextTime = getNextCronTime(task.scheduleExpression)
              await updateNextExecution(task.id, nextTime, '')
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
    console.log(
      `[TaskScheduler] Executing task ${task.id} for agent ${task.agentSlug}`
    )

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
    const containerSession = await client.createSession({
      availableEnvVars:
        availableEnvVars.length > 0 ? availableEnvVars : undefined,
      initialMessage: task.prompt,
    })

    const sessionId = containerSession.id
    const sessionName = task.name || 'Scheduled Task'

    // Register the session
    await registerSession(task.agentSlug, sessionId, sessionName)

    // Update session metadata to mark it as created from a scheduled task
    await updateSessionMetadata(task.agentSlug, sessionId, {
      isScheduledExecution: true,
      scheduledTaskId: task.id,
      scheduledTaskName: task.name || undefined,
    })

    // Subscribe to the session for SSE updates
    messagePersister.subscribeToSession(
      sessionId,
      client,
      sessionId,
      task.agentSlug
    )
    messagePersister.markSessionActive(sessionId, task.agentSlug)

    console.log(
      `[TaskScheduler] Task ${task.id} started, session: ${sessionId}`
    )

    // Trigger scheduled session started notification
    notificationManager.triggerScheduledSessionStarted(
      sessionId,
      task.agentSlug,
      task.name || undefined
    ).catch((err) => {
      console.error('[TaskScheduler] Failed to trigger scheduled notification:', err)
    })

    // Update task status
    if (task.isRecurring) {
      // Update next execution time for recurring tasks
      const nextTime = getNextCronTime(task.scheduleExpression)
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

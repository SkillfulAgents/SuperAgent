/**
 * Auto-Sleep Monitor
 *
 * Background process that periodically checks running containers and stops
 * those that have been idle (no active sessions, no recent activity) for
 * longer than a configurable timeout.
 */

import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { listSessions } from '@shared/lib/services/session-service'
import { getSettings } from '@shared/lib/config/settings'

class AutoSleepMonitor {
  private intervalId: NodeJS.Timeout | null = null
  private isRunning = false
  private pollIntervalMs = 60000 // Check every minute
  private isProcessing = false

  /**
   * Start the monitor.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[AutoSleepMonitor] Already running')
      return
    }

    this.isRunning = true
    console.log('[AutoSleepMonitor] Starting monitor...')

    // Start periodic polling
    this.intervalId = setInterval(() => {
      this.checkIdleContainers().catch((error) => {
        console.error('[AutoSleepMonitor] Error in check cycle:', error)
      })
    }, this.pollIntervalMs)

    console.log(
      `[AutoSleepMonitor] Monitor started, polling every ${this.pollIntervalMs / 1000}s`
    )
  }

  /**
   * Stop the monitor.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.isRunning = false
    console.log('[AutoSleepMonitor] Monitor stopped')
  }

  /**
   * Check all running containers and stop any that have been idle too long.
   */
  private async checkIdleContainers(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    try {
      const settings = getSettings()
      const timeoutMinutes = settings.app?.autoSleepTimeoutMinutes ?? 30

      // 0 means disabled
      if (timeoutMinutes <= 0) return

      // getRunningAgentIds uses cached status (no docker process spawned)
      const runningAgentIds = containerManager.getRunningAgentIds()
      if (runningAgentIds.length === 0) return

      const now = Date.now()
      const timeoutMs = timeoutMinutes * 60 * 1000

      for (const agentId of runningAgentIds) {
        try {
          // Skip if any session is currently processing a request
          if (messagePersister.hasActiveSessionsForAgent(agentId)) {
            continue
          }

          // Use container start time as a floor — when an agent is woken up
          // to view its dashboard, session timestamps are stale from before
          // the previous sleep and would cause immediate re-sleep.
          const containerStartTime =
            containerManager.getContainerStartTime(agentId) ?? 0
          const lastKeepAlive =
            containerManager.getLastKeepAlive(agentId) ?? 0

          // Runtimes with an in-memory activity clock (Lambda MicroVM) skip
          // listSessions — that path hits S3 Files and was pure cost when the
          // eventual stop was a no-op / when activity is already known in RAM.
          const cachedActivity =
            containerManager.getCachedLastActivityMs(agentId)

          let lastActivity: number
          if (cachedActivity !== undefined) {
            lastActivity = Math.max(
              containerStartTime,
              lastKeepAlive,
              cachedActivity
            )
          } else {
            const sessions = await listSessions(agentId)

            // No sessions — container was just started, skip it
            if (sessions.length === 0) {
              continue
            }

            lastActivity = Math.max(
              containerStartTime,
              lastKeepAlive,
              ...sessions.map((s) => s.lastActivityAt.getTime())
            )
          }

          if (now - lastActivity > timeoutMs) {
            console.log(
              `[AutoSleepMonitor] Agent ${agentId} idle for >${timeoutMinutes}m, stopping...`
            )

            await containerManager.stopContainer(agentId, {
              stopTimeoutMs: 60_000,
              killTimeoutMs: 30_000,
              // Never force-stop the shared VM from a background idle sweep — it
              // would kill every running agent to reclaim one idle container. If
              // stop+kill time out, leave it running and retry next cycle.
              escalateToForceStop: false,
            })
          }
        } catch (error) {
          console.error(
            `[AutoSleepMonitor] Error checking agent ${agentId}:`,
            error
          )
        }
      }
    } finally {
      this.isProcessing = false
    }
  }
}

// Export singleton instance
// Use globalThis to persist across hot reloads in development
const globalForMonitor = globalThis as unknown as {
  autoSleepMonitor: AutoSleepMonitor | undefined
}

export const autoSleepMonitor =
  globalForMonitor.autoSleepMonitor ?? new AutoSleepMonitor()

if (process.env.NODE_ENV !== 'production') {
  globalForMonitor.autoSleepMonitor = autoSleepMonitor
}

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

      const runningAgentIds = await containerManager.getRunningAgentIds()
      if (runningAgentIds.length === 0) return

      const now = Date.now()
      const timeoutMs = timeoutMinutes * 60 * 1000

      for (const agentId of runningAgentIds) {
        try {
          // Skip if any session is currently processing a request
          if (messagePersister.hasActiveSessionsForAgent(agentId)) {
            continue
          }

          // Check last activity across all sessions
          const sessions = await listSessions(agentId)

          // No sessions — container was just started, skip it
          if (sessions.length === 0) {
            continue
          }

          const lastActivity = Math.max(
            ...sessions.map((s) => s.lastActivityAt.getTime())
          )

          if (now - lastActivity > timeoutMs) {
            console.log(
              `[AutoSleepMonitor] Agent ${agentId} idle for >${timeoutMinutes}m, stopping...`
            )

            const client = containerManager.getClient(agentId)
            await client.stop()

            // Broadcast status change so UI updates
            messagePersister.broadcastGlobal({
              type: 'agent_status_changed',
              agentSlug: agentId,
              status: 'stopped',
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

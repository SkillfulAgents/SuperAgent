/**
 * Auto-Sleep Monitor
 *
 * Background process that periodically asks every running agent how long it
 * has been idle and stops the ones idle for longer than a configurable
 * timeout.
 *
 * The facts and the verb are the actor's: `container.idleSince()` is a clock
 * the actor keeps in memory from the events that define activity, and
 * `container.stop()` is how it sleeps. A sweep therefore reads nothing from
 * disk — one settings lookup, then one in-memory read per running agent.
 */

import { agentRegistry } from '@shared/lib/agent-actor'
import { getSettings } from '@shared/lib/config/settings'

/**
 * Whether an agent whose idle clock reads `idleSince` (see
 * `ContainerOps.idleSince`) has been idle for longer than `timeoutMs` at
 * `now`. A `null` clock — busy, or nothing recorded yet — is never idle.
 */
export function idleLongerThan(idleSince: number | null, timeoutMs: number, now: number): boolean {
  return idleSince !== null && now - idleSince > timeoutMs
}

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
      this.sweep().catch((error) => {
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
   * One sweep: stop every running agent that has been idle for longer than
   * the configured timeout. Public so it can be run without the interval.
   */
  async sweep(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    try {
      const settings = getSettings()
      const timeoutMinutes = settings.app?.autoSleepTimeoutMinutes ?? 30

      // 0 means disabled
      if (timeoutMinutes <= 0) return

      // Running agents come from cached status (no docker process spawned)
      const runningAgents = agentRegistry.running()
      if (runningAgents.length === 0) return

      const now = Date.now()
      const timeoutMs = timeoutMinutes * 60 * 1000

      for (const actor of runningAgents) {
        const agentId = actor.slug
        try {
          if (!idleLongerThan(actor.container.idleSince(), timeoutMs, now)) {
            continue
          }

          console.log(
            `[AutoSleepMonitor] Agent ${agentId} idle for >${timeoutMinutes}m, stopping...`
          )

          await actor.container.stop({
            stopTimeoutMs: 60_000,
            killTimeoutMs: 30_000,
            // Never force-stop the shared VM from a background idle sweep — it
            // would kill every running agent to reclaim one idle container. If
            // stop+kill time out, leave it running and retry next cycle.
            escalateToForceStop: false,
          })
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

/**
 * Auto Time-Based Compact Coordinator (V0)
 *
 * Polls periodically; for each running agent, finds idle sessions whose
 * activity began in this app run and runs recency compaction on them.
 *
 * Behavior is driven by AppPreferences:
 *   - autoCompactIdleMinutes: 0 disables the feature; >0 is the idle
 *     threshold. Read fresh on every tick, so toggling the setting takes
 *     effect on the next minute boundary without restart.
 *   - autoCompactKeepTurns: how many recent user turns to keep verbatim.
 *
 * Hardcoded (V0):
 *   - Sessions whose lastActivityAt predates this coordinator's startedAt
 *     are treated as archived and never compacted — they only become
 *     eligible after the user revisits them and generates new activity.
 *   - Active sessions are never compacted.
 */

import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { getSettings } from '@shared/lib/config/settings'
import { listSessions } from '@shared/lib/services/session-service'
import { advanceAutoTimeCompact } from '@shared/lib/services/auto-time-compact'

const POLL_INTERVAL_MS = 60_000
const DEFAULT_MIN_NEW_TURNS = 4

class AutoTimeCompactCoordinator {
  private intervalId: NodeJS.Timeout | null = null
  private isProcessing = false
  private startedAt = 0
  private readonly processingSessions = new Set<string>()

  async start(): Promise<void> {
    if (this.intervalId) {
      console.log('[AutoTimeCompactCoordinator] already running')
      return
    }
    this.startedAt = Date.now()
    console.log(
      `[AutoTimeCompactCoordinator] starting (poll=${POLL_INTERVAL_MS / 1000}s); ` +
        `idle threshold and keepTurns are read from settings on each tick.`
    )
    this.intervalId = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[AutoTimeCompactCoordinator] tick failed:', err)
      })
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    console.log('[AutoTimeCompactCoordinator] stopped')
  }

  private async tick(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    try {
      const settings = getSettings()
      const idleMinutes = settings.app?.autoCompactIdleMinutes ?? 0
      if (idleMinutes <= 0) return // disabled

      const idleMs = idleMinutes * 60_000
      const minNewTurns = Math.max(
        1,
        settings.app?.autoCompactMinNewTurns ?? DEFAULT_MIN_NEW_TURNS
      )
      const now = Date.now()

      for (const agentSlug of containerManager.getRunningAgentIds()) {
        let sessions
        try {
          sessions = await listSessions(agentSlug)
        } catch (err) {
          console.error(
            `[AutoTimeCompactCoordinator] listSessions(${agentSlug}) failed:`,
            err
          )
          continue
        }

        for (const session of sessions) {
          if (this.processingSessions.has(session.id)) continue
          if (messagePersister.isSessionActive(session.id)) continue
          if (now - session.lastActivityAt.getTime() < idleMs) continue
          // Don't retroactively touch sessions that were already idle when
          // the app started — they're effectively archived. They become
          // eligible once the user generates new activity in them.
          if (session.lastActivityAt.getTime() < this.startedAt) continue

          this.processingSessions.add(session.id)
          try {
            await advanceAutoTimeCompact(agentSlug, session.id, minNewTurns)
          } catch (err) {
            console.error(
              `[AutoTimeCompactCoordinator] ${agentSlug}/${session.id} failed:`,
              err
            )
          } finally {
            this.processingSessions.delete(session.id)
          }
        }
      }
    } finally {
      this.isProcessing = false
    }
  }
}

const globalForCoordinator = globalThis as unknown as {
  autoTimeCompactCoordinator: AutoTimeCompactCoordinator | undefined
}

export const autoTimeCompactCoordinator =
  globalForCoordinator.autoTimeCompactCoordinator ??
  new AutoTimeCompactCoordinator()

if (process.env.NODE_ENV !== 'production') {
  globalForCoordinator.autoTimeCompactCoordinator = autoTimeCompactCoordinator
}

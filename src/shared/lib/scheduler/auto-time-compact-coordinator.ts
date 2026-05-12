/**
 * Per-session auto-time-compact poller. 60s tick. Only acts on sessions
 * with metadata.autoCompactEnabled === true, idle >= IDLE_MS, last active
 * in this app run, and not currently processing a request.
 */

import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import {
  getSessionMetadata,
  listSessions,
} from '@shared/lib/services/session-service'
import { advanceAutoTimeCompact } from '@shared/lib/services/auto-time-compact'

const POLL_INTERVAL_MS = 30_000
// TODO: restore to 4 * 60_000 (1 min before the 5-min cache TTL) before merge.
const IDLE_MS = 1 * 60_000
// Keep the most recent N tool_use calls verbatim in the summary; earlier
// tool I/O collapses into a single `[...]` placeholder.
const KEEP_LAST_TOOLS = 10

class AutoTimeCompactCoordinator {
  private intervalId: NodeJS.Timeout | null = null
  private isProcessing = false
  private startedAt = 0
  private readonly processingSessions = new Set<string>()

  async start(): Promise<void> {
    if (this.intervalId) return
    this.startedAt = Date.now()
    console.log(
      `[AutoTimeCompactCoordinator] starting (poll=${POLL_INTERVAL_MS / 1000}s, idle=${IDLE_MS / 1000}s, keepLastTools=${KEEP_LAST_TOOLS})`
    )
    this.intervalId = setInterval(() => {
      this.tick().catch((err) =>
        console.error('[AutoTimeCompactCoordinator] tick failed:', err)
      )
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  private async tick(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true
    try {
      const now = Date.now()
      for (const agentSlug of containerManager.getRunningAgentIds()) {
        let sessions
        try {
          sessions = await listSessions(agentSlug)
        } catch (err) {
          console.error(`[AutoTimeCompactCoordinator] listSessions(${agentSlug}):`, err)
          continue
        }
        for (const session of sessions) {
          if (this.processingSessions.has(session.id)) continue
          if (!session.autoCompactEnabled) continue
          if (messagePersister.isSessionActive(session.id)) continue
          if (now - session.lastActivityAt.getTime() < IDLE_MS) continue
          // Skip sessions that were already idle when the app started — they
          // become eligible once the user revisits them.
          if (session.lastActivityAt.getTime() < this.startedAt) continue
          // Double-check metadata in case the listSessions cache is stale.
          const meta = await getSessionMetadata(agentSlug, session.id)
          if (!meta?.autoCompactEnabled) continue

          this.processingSessions.add(session.id)
          try {
            await advanceAutoTimeCompact(agentSlug, session.id, KEEP_LAST_TOOLS)
          } catch (err) {
            console.error(
              `[AutoTimeCompactCoordinator] ${agentSlug}/${session.id}:`,
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

const globalFor = globalThis as unknown as {
  autoTimeCompactCoordinator: AutoTimeCompactCoordinator | undefined
}
export const autoTimeCompactCoordinator =
  globalFor.autoTimeCompactCoordinator ?? new AutoTimeCompactCoordinator()
if (process.env.NODE_ENV !== 'production') {
  globalFor.autoTimeCompactCoordinator = autoTimeCompactCoordinator
}

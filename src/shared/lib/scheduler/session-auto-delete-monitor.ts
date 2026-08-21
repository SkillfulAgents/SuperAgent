import { listAgents } from '@shared/lib/services/agent-service'
import {
  listSessions,
  readSessionMetadata,
  deleteSessionsBatch,
} from '@shared/lib/services/session-service'
import { readAgentPreferences } from '@shared/lib/services/agent-preferences-service'
import { deleteNotificationsBySessionIds } from '@shared/lib/services/notification-service'
import { listSessionIdsWithPendingWakes } from '@shared/lib/services/scheduled-task-service'
import { messagePersister } from '@shared/lib/container/message-persister'
import { getSettings } from '@shared/lib/config/settings'
import { isAuthMode } from '@shared/lib/auth/mode'
import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'
import { inArray } from 'drizzle-orm'

class SessionAutoDeleteMonitor {
  private intervalId: NodeJS.Timeout | null = null
  private startupTimeoutId: NodeJS.Timeout | null = null
  private isRunning = false
  private isProcessing = false
  private pollIntervalMs = 4 * 60 * 60 * 1000 // Every 4 hours
  private startupDelayMs = 30_000 // 30 seconds after startup

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[SessionAutoDeleteMonitor] Already running')
      return
    }

    this.isRunning = true
    console.log('[SessionAutoDeleteMonitor] Starting monitor...')

    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null
      this.cleanupAllAgents().catch((error) => {
        console.error('[SessionAutoDeleteMonitor] Error in initial cleanup:', error)
      })

      this.intervalId = setInterval(() => {
        this.cleanupAllAgents().catch((error) => {
          console.error('[SessionAutoDeleteMonitor] Error in cleanup cycle:', error)
        })
      }, this.pollIntervalMs)
    }, this.startupDelayMs)

    console.log(
      `[SessionAutoDeleteMonitor] Monitor started, first run in ${this.startupDelayMs / 1000}s, then every ${this.pollIntervalMs / 3_600_000}h`
    )
  }

  stop(): void {
    if (this.startupTimeoutId) {
      clearTimeout(this.startupTimeoutId)
      this.startupTimeoutId = null
    }
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.isRunning = false
    console.log('[SessionAutoDeleteMonitor] Monitor stopped')
  }

  private async cleanupAllAgents(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    try {
      const globalDefault = getSettings().app?.autoDeleteInactiveDays
      const agents = await listAgents()

      for (const agent of agents) {
        try {
          const agentPrefs = await readAgentPreferences(agent.slug)
          const effectiveDays = agentPrefs.autoDeleteInactiveDays ?? globalDefault
          if (effectiveDays === undefined || effectiveDays <= 0) continue

          await this.cleanupAgent(agent.slug, effectiveDays)
        } catch (error) {
          console.error(
            `[SessionAutoDeleteMonitor] Error cleaning agent ${agent.slug}:`,
            error
          )
        }
      }
    } finally {
      this.isProcessing = false
    }
  }

  private async cleanupAgent(
    agentSlug: string,
    inactiveDays: number
  ): Promise<void> {
    const sessions = await listSessions(agentSlug)
    if (sessions.length === 0) return

    const metadata = await readSessionMetadata(agentSlug)
    const cutoff = Date.now() - inactiveDays * 86_400_000
    // A long-sleeping session can be inactive far past the cutoff by design —
    // deleting it would silently destroy the very session its wake resumes.
    const pendingWakeSessionIds = await listSessionIdsWithPendingWakes(agentSlug)

    const toDelete = sessions
      .filter((s) => {
        if (s.lastActivityAt.getTime() >= cutoff) return false
        if (metadata[s.id]?.starred) return false
        if (messagePersister.isSessionActive(s.id)) return false
        if (pendingWakeSessionIds.has(s.id)) return false
        return true
      })
      .map((s) => s.id)

    if (toDelete.length === 0) return

    const deletedIds = await deleteSessionsBatch(agentSlug, toDelete)

    for (const sessionId of deletedIds) {
      messagePersister.unsubscribeFromSession(sessionId)
    }

    if (isAuthMode() && deletedIds.length > 0) {
      try {
        await db
          .delete(messageAuthor)
          .where(inArray(messageAuthor.sessionId, deletedIds))
      } catch (error) {
        console.error(
          `[SessionAutoDeleteMonitor] Failed to clean messageAuthor records for ${agentSlug}:`,
          error
        )
      }
    }

    // Remove notification rows for the deleted sessions. Notifications exist in
    // both auth and non-auth modes (userId is nullable), so this runs
    // unconditionally. Use `deletedIds` (not `toDelete`) so failed filesystem
    // deletions never wipe DB state for a session that still exists on disk.
    try {
      await deleteNotificationsBySessionIds(deletedIds)
    } catch (error) {
      console.error(
        `[SessionAutoDeleteMonitor] Failed to clean notification records for ${agentSlug}:`,
        error
      )
    }

    console.log(
      `[SessionAutoDeleteMonitor] Deleted ${deletedIds.length}/${toDelete.length} inactive sessions for agent ${agentSlug} (older than ${inactiveDays} days)`
    )
  }
}

const globalForMonitor = globalThis as unknown as {
  sessionAutoDeleteMonitor: SessionAutoDeleteMonitor | undefined
}

export const sessionAutoDeleteMonitor =
  globalForMonitor.sessionAutoDeleteMonitor ?? new SessionAutoDeleteMonitor()

if (process.env.NODE_ENV !== 'production') {
  globalForMonitor.sessionAutoDeleteMonitor = sessionAutoDeleteMonitor
}

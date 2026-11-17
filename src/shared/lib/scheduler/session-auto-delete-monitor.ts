import { listAgents } from '@shared/lib/services/agent-service'
import { readStoredAgentPreferences } from '@shared/lib/services/agent-preferences-service'
import { deleteSessionRecords } from '@shared/lib/services/session-deletion'
import { listSessionIdsWithPendingWakes } from '@shared/lib/services/scheduled-task-service'
import { agentRegistry } from '@shared/lib/agent-actor'
import { getSettings } from '@shared/lib/config/settings'
import { background } from '@shared/lib/background'
import { PassTask, taskManager, type Service } from '@shared/lib/background-work'

class SessionAutoDeleteMonitor implements Service {
  readonly id = 'session-auto-delete'
  readonly phase = 'background' as const
  private isRunning = false
  private isProcessing = false
  private pollIntervalMs = 4 * 60 * 60 * 1000 // Every 4 hours
  private startupDelayMs = 30_000 // 30 seconds after startup
  private readonly cleanupTask = new PassTask('sessions.auto-delete', () => this.cleanupAllAgents().catch((error) => {
    console.error('[SessionAutoDeleteMonitor] Error in cleanup cycle:', error)
  }))
  readonly tasks = [this.cleanupTask]

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[SessionAutoDeleteMonitor] Already running')
      return
    }

    this.isRunning = true
    console.log('[SessionAutoDeleteMonitor] Starting monitor...')

    await taskManager().ensureEvery(this.cleanupTask.type, this.cleanupTask.spec, {
      intervalMs: this.pollIntervalMs,
      initialDelayMs: this.startupDelayMs,
    })

    console.log(
      `[SessionAutoDeleteMonitor] Monitor started, first run in ${this.startupDelayMs / 1000}s, then every ${this.pollIntervalMs / 3_600_000}h`
    )
  }

  stop(): void {
    background(taskManager().cancel(this.cleanupTask.type), { name: 'session-auto-delete-monitor.cancel-cleanup' })
    this.isRunning = false
    console.log('[SessionAutoDeleteMonitor] Monitor stopped')
  }

  private async cleanupAllAgents(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    try {
      const globalDefault = (await getSettings()).app?.autoDeleteInactiveDays
      const agents = await listAgents()

      for (const agent of agents) {
        try {
          const agentPrefs = await readStoredAgentPreferences(agent.slug)
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
    const actor = agentRegistry.get(agentSlug)
    const sessions = await actor.sessions.list()
    if (sessions.length === 0) return

    const metadata = await actor.sessions.readMetadata()
    const cutoff = Date.now() - inactiveDays * 86_400_000
    // A long-sleeping session can be inactive far past the cutoff by design —
    // deleting it would silently destroy the very session its wake resumes.
    const pendingWakeSessionIds = await listSessionIdsWithPendingWakes(agentSlug)

    const active = new Set((await actor.live()).activeSessionIds)
    const toDelete = sessions
      .filter((s) => {
        if (s.lastActivityAt.getTime() >= cutoff) return false
        if (metadata[s.id]?.starred) return false
        if (active.has(s.id)) return false
        if (pendingWakeSessionIds.has(s.id)) return false
        return true
      })
      .map((s) => s.id)

    if (toDelete.length === 0) return

    // Lets go of each deleted session's stream too.
    const deletedIds = await actor.sessions.deleteMany(toDelete)

    // What the host keeps about them, as a single delete removes it. Of
    // `deletedIds`, not `toDelete`: a session whose delete failed still
    // exists, and keeps its records.
    try {
      await deleteSessionRecords(agentSlug, deletedIds)
    } catch (error) {
      console.error(
        `[SessionAutoDeleteMonitor] Failed to clean the records of deleted sessions for ${agentSlug}:`,
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

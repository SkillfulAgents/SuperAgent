import { listAgents } from '@shared/lib/services/agent-service'
import { readAgentPreferences } from '@shared/lib/services/agent-preferences-service'
import { getSettings } from '@shared/lib/config/settings'
import { resolveApiLogAutoDeleteDays } from '@shared/lib/config/api-log-auto-delete'
import { pruneExpiredApiLogsForAgent } from '@shared/lib/services/api-log-auto-delete'
import { sqlite } from '@shared/lib/db'
import { captureException } from '@shared/lib/error-reporting'

class ApiLogAutoDeleteMonitor {
  private intervalId: NodeJS.Timeout | null = null
  private startupTimeoutId: NodeJS.Timeout | null = null
  private isRunning = false
  private isProcessing = false
  private pollIntervalMs = 4 * 60 * 60 * 1000
  private startupDelayMs = 30_000

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[ApiLogAutoDeleteMonitor] Already running')
      return
    }

    this.isRunning = true
    console.log('[ApiLogAutoDeleteMonitor] Starting monitor...')

    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null
      this.cleanupAllAgents().catch((error) => {
        console.error('[ApiLogAutoDeleteMonitor] Error in initial cleanup:', error)
        captureException(error, { tags: { area: 'api-log-auto-delete', op: 'initial-cleanup' } })
      })

      this.intervalId = setInterval(() => {
        this.cleanupAllAgents().catch((error) => {
          console.error('[ApiLogAutoDeleteMonitor] Error in cleanup cycle:', error)
          captureException(error, { tags: { area: 'api-log-auto-delete', op: 'cleanup-cycle' } })
        })
      }, this.pollIntervalMs)
    }, this.startupDelayMs)

    console.log(
      `[ApiLogAutoDeleteMonitor] Monitor started, first run in ${this.startupDelayMs / 1000}s, then every ${this.pollIntervalMs / 3_600_000}h`,
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
    console.log('[ApiLogAutoDeleteMonitor] Monitor stopped')
  }

  private async cleanupAllAgents(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    try {
      const appDays = getSettings().app?.apiLogAutoDeleteDays
      const agents = await listAgents()

      for (const agent of agents) {
        try {
          const agentPrefs = await readAgentPreferences(agent.slug)
          const effectiveDays = resolveApiLogAutoDeleteDays(
            agentPrefs.apiLogAutoDeleteDays,
            appDays,
          )
          if (effectiveDays <= 0) continue

          const cutoff = Date.now() - effectiveDays * 86_400_000
          const { proxyDeleted, mcpDeleted } = await pruneExpiredApiLogsForAgent(
            sqlite,
            agent.slug,
            cutoff,
          )
          if (proxyDeleted + mcpDeleted === 0) continue

          console.log(
            `[ApiLogAutoDeleteMonitor] Deleted ${proxyDeleted} proxy / ${mcpDeleted} MCP audit rows for ${agent.slug} (older than ${effectiveDays} days)`,
          )
        } catch (error) {
          console.error(
            `[ApiLogAutoDeleteMonitor] Error cleaning agent ${agent.slug}:`,
            error,
          )
          captureException(error, {
            tags: { area: 'api-log-auto-delete', op: 'cleanup-agent' },
            extra: { agentSlug: agent.slug },
          })
        }
      }
    } finally {
      this.isProcessing = false
    }
  }
}

const globalForMonitor = globalThis as unknown as {
  apiLogAutoDeleteMonitor: ApiLogAutoDeleteMonitor | undefined
}

export const apiLogAutoDeleteMonitor =
  globalForMonitor.apiLogAutoDeleteMonitor ?? new ApiLogAutoDeleteMonitor()

if (process.env.NODE_ENV !== 'production') {
  globalForMonitor.apiLogAutoDeleteMonitor = apiLogAutoDeleteMonitor
}

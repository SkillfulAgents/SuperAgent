import { createContainerClient, checkAllRunnersAvailability, checkImageExists, pullImage, canBuildImage, buildImage, startRunner, refreshRunnerAvailability, type ContainerRunner } from './client-factory'
import type { ContainerClient, ContainerConfig, ContainerInfo, HealthCheckResult, RuntimeReadiness } from './types'
import { healthMonitor } from './health-monitor'
import { db } from '@shared/lib/db'
import { agentConnectedAccounts, connectedAccounts } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getOrCreateProxyToken } from '@shared/lib/proxy/token-store'
import { getContainerHostUrl, getAppPort } from '@shared/lib/proxy/host-url'
import { getSettings, updateSettings } from '@shared/lib/config/settings'
import { getAgentWorkspaceDir } from '@shared/lib/config/data-dir'
import { copyChromeProfileData } from '@shared/lib/browser/chrome-profile'
import { messagePersister } from './message-persister'

/** Interval for syncing container status with reality (in ms). Default: 300 seconds */
const STATUS_SYNC_INTERVAL_MS = parseInt(
  process.env.CONTAINER_STATUS_SYNC_INTERVAL_SECONDS || '300',
  10
) * 1000

/** Interval for health monitoring (in ms). Default: 30 seconds */
const HEALTH_CHECK_INTERVAL_MS = parseInt(
  process.env.CONTAINER_HEALTH_CHECK_INTERVAL_SECONDS || '30',
  10
) * 1000

/** Cached container status */
interface CachedContainerStatus {
  status: 'running' | 'stopped'
  port: number | null
  lastSyncedAt: number
}

// Singleton to manage all container clients
class ContainerManager {
  private clients: Map<string, ContainerClient> = new Map()
  private containerStartedAt: Map<string, number> = new Map()
  /** Cached container statuses - avoids repeated docker inspect calls */
  private containerStatuses: Map<string, CachedContainerStatus> = new Map()
  private syncIntervalId: NodeJS.Timeout | null = null
  private isSyncing = false
  private healthCheckIntervalId: NodeJS.Timeout | null = null
  /** Cached health warnings per agent */
  private healthWarnings: Map<string, HealthCheckResult[]> = new Map()

  /** Unified runtime readiness state */
  private _readiness: RuntimeReadiness = process.env.E2E_MOCK === 'true'
    ? { status: 'READY', message: 'Ready (E2E mock)', pullProgress: null }
    : { status: 'CHECKING', message: 'Checking runtime availability...', pullProgress: null }

  // Get or create a container client for an agent
  getClient(agentId: string): ContainerClient {
    let client = this.clients.get(agentId)

    if (!client) {
      const config: ContainerConfig = {
        agentId,
        onConnectionError: () => {
          // When a connection error is detected, sync status with Docker
          // This handles cases where the container crashed or was stopped externally
          console.log(`[ContainerManager] Connection error for ${agentId}, syncing status...`)
          this.syncAgentStatus(agentId).catch((err) => {
            console.error(`[ContainerManager] Failed to sync status after connection error:`, err)
            // If sync fails, mark as stopped as a fallback and broadcast
            this.markAsStopped(agentId)
            messagePersister.markAllSessionsInactiveForAgent(agentId)
            messagePersister.broadcastGlobal({
              type: 'agent_status_changed',
              agentSlug: agentId,
              status: 'stopped',
            })
          })
        },
      }

      client = createContainerClient(config)
      this.clients.set(agentId, client)
    }

    return client
  }

  /**
   * Get cached container info. Returns cached status if available,
   * otherwise returns stopped (will be corrected on next sync).
   */
  getCachedInfo(agentId: string): ContainerInfo {
    const cached = this.containerStatuses.get(agentId)
    if (cached) {
      return { status: cached.status, port: cached.port }
    }
    // Default to stopped if not in cache
    return { status: 'stopped', port: null }
  }

  /**
   * Update cached container status. Called after start/stop operations.
   */
  updateCachedStatus(agentId: string, status: 'running' | 'stopped', port: number | null): void {
    this.containerStatuses.set(agentId, {
      status,
      port,
      lastSyncedAt: Date.now(),
    })
  }

  /**
   * Mark a container as stopped in cache (e.g., when connection fails).
   * Prefer using stopContainer() which also stops the actual container.
   */
  markAsStopped(agentId: string): void {
    this.updateCachedStatus(agentId, 'stopped', null)
  }

  /**
   * Stop a container and update all related state.
   * This is the preferred way to stop a container - handles cache, broadcasts, and session state.
   */
  async stopContainer(agentId: string): Promise<void> {
    const client = this.getClient(agentId)
    await client.stop()

    // Update cached status
    this.markAsStopped(agentId)

    // Mark all sessions for this agent as inactive
    messagePersister.markAllSessionsInactiveForAgent(agentId)

    // Broadcast status change so UI updates
    messagePersister.broadcastGlobal({
      type: 'agent_status_changed',
      agentSlug: agentId,
      status: 'stopped',
    })
  }

  /**
   * Sync a single agent's status with reality by querying Docker.
   * Broadcasts status change if the actual status differs from cached.
   */
  async syncAgentStatus(agentId: string): Promise<ContainerInfo> {
    const client = this.getClient(agentId)
    const previousStatus = this.containerStatuses.get(agentId)?.status
    const info = await client.getInfoFromRuntime()
    this.updateCachedStatus(agentId, info.status, info.port)

    // Broadcast if status changed (e.g., container was stopped externally)
    if (previousStatus && previousStatus !== info.status) {
      console.log(`[ContainerManager] Status changed for ${agentId}: ${previousStatus} -> ${info.status}`)
      messagePersister.broadcastGlobal({
        type: 'agent_status_changed',
        agentSlug: agentId,
        status: info.status,
      })

      // If container stopped, mark sessions as inactive
      if (info.status === 'stopped') {
        messagePersister.markAllSessionsInactiveForAgent(agentId)
      }
    }

    return info
  }

  /**
   * Sync all known agents' statuses with reality.
   * Called on startup and periodically.
   */
  async syncAllStatuses(): Promise<void> {
    if (this.isSyncing) {
      console.log('[ContainerManager] Sync already in progress, skipping')
      return
    }

    this.isSyncing = true
    console.log('[ContainerManager] Syncing container statuses with Docker...')

    try {
      const agentIds = Array.from(this.clients.keys())

      for (const agentId of agentIds) {
        try {
          await this.syncAgentStatus(agentId)
        } catch (error) {
          console.error(`[ContainerManager] Failed to sync status for ${agentId}:`, error)
          // Mark as stopped on error
          this.markAsStopped(agentId)
        }
      }

      console.log(`[ContainerManager] Synced ${agentIds.length} container statuses`)
    } finally {
      this.isSyncing = false
    }
  }

  /**
   * Initialize clients for the given agent slugs and sync their statuses.
   * Call this on app startup with the list of all agent slugs.
   */
  async initializeAgents(agentSlugs: string[]): Promise<void> {
    console.log(`[ContainerManager] Initializing ${agentSlugs.length} agents...`)

    // Register callback so message-persister can request container stops on fatal errors (e.g., OOM)
    messagePersister.setStopContainerCallback((agentSlug) => {
      console.log(`[ContainerManager] Stopping container for ${agentSlug} due to fatal error`)
      this.stopContainer(agentSlug).catch((err) => {
        console.error(`[ContainerManager] Failed to stop container for ${agentSlug}:`, err)
      })
    })

    // Create clients for all agents (this registers them for sync)
    for (const slug of agentSlugs) {
      this.getClient(slug)
    }

    // Sync all statuses
    await this.syncAllStatuses()

    console.log(`[ContainerManager] Initialized ${agentSlugs.length} agents`)
  }

  /**
   * Start the periodic status sync.
   * Note: Does not do an initial sync - call initializeAgents() first for that.
   */
  startStatusSync(): void {
    if (this.syncIntervalId) {
      return // Already running
    }

    console.log(`[ContainerManager] Starting status sync (interval: ${STATUS_SYNC_INTERVAL_MS / 1000}s)`)

    // Set up periodic sync (initial sync is done by initializeAgents)
    this.syncIntervalId = setInterval(() => {
      this.syncAllStatuses().catch((error) => {
        console.error('[ContainerManager] Periodic sync failed:', error)
      })
    }, STATUS_SYNC_INTERVAL_MS)
  }

  /**
   * Stop the periodic status sync.
   */
  stopStatusSync(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId)
      this.syncIntervalId = null
      console.log('[ContainerManager] Stopped status sync')
    }
  }

  /**
   * Start periodic health monitoring for running containers.
   */
  startHealthMonitor(): void {
    if (this.healthCheckIntervalId) {
      return // Already running
    }

    console.log(`[ContainerManager] Starting health monitor (interval: ${HEALTH_CHECK_INTERVAL_MS / 1000}s)`)

    this.healthCheckIntervalId = setInterval(() => {
      this.runHealthChecks().catch((error) => {
        console.error('[ContainerManager] Health check failed:', error)
      })
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  /**
   * Stop the periodic health monitor.
   */
  stopHealthMonitor(): void {
    if (this.healthCheckIntervalId) {
      clearInterval(this.healthCheckIntervalId)
      this.healthCheckIntervalId = null
      console.log('[ContainerManager] Stopped health monitor')
    }
  }

  /**
   * Run health checks on all running containers.
   */
  private async runHealthChecks(): Promise<void> {
    const runningIds = this.getRunningAgentIds()
    if (runningIds.length === 0) return

    for (const agentId of runningIds) {
      try {
        const client = this.clients.get(agentId)
        if (!client) continue

        const stats = await client.getStats()
        if (!stats) continue

        const warnings = healthMonitor.checkAll(agentId, stats)
        const previous = this.healthWarnings.get(agentId) || []

        // Broadcast only if warnings changed
        const changed = warnings.length !== previous.length ||
          warnings.some((w, i) => w.status !== previous[i]?.status || w.checkName !== previous[i]?.checkName)

        this.healthWarnings.set(agentId, warnings)

        if (changed) {
          messagePersister.broadcastGlobal({
            type: 'container_health_changed',
            agentSlug: agentId,
            warnings,
          })
        }
      } catch (error) {
        console.error(`[ContainerManager] Health check failed for ${agentId}:`, error)
      }
    }
  }

  /**
   * Get cached health warnings for an agent.
   */
  getHealthWarnings(agentId: string): HealthCheckResult[] {
    return this.healthWarnings.get(agentId) || []
  }

  // Ensure container is running, starting it with connected accounts if needed
  // Returns the container client
  //
  // Note: User secrets are now stored in .env file in the workspace,
  // not passed as env vars. Only connected account tokens are injected.
  //
  // Parameter is agentId for backwards compatibility, but will be slug after migration
  async ensureRunning(agentId: string): Promise<ContainerClient> {
    const client = this.getClient(agentId)
    // Use cached status to avoid unnecessary docker calls
    const cachedInfo = this.getCachedInfo(agentId)

    if (cachedInfo.status !== 'running') {
      // Pass proxy config and account metadata (no raw tokens)
      const envVars: Record<string, string> = {}

      // Set up proxy authentication
      const proxyToken = await getOrCreateProxyToken(agentId)
      const hostUrl = getContainerHostUrl()
      const appPort = getAppPort()
      envVars['PROXY_BASE_URL'] = `http://${hostUrl}:${appPort}/api/proxy/${agentId}`
      envVars['PROXY_TOKEN'] = proxyToken

      // Fetch connected accounts for this agent
      const accountMappings = await db
        .select({
          account: connectedAccounts,
        })
        .from(agentConnectedAccounts)
        .innerJoin(
          connectedAccounts,
          eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id)
        )
        .where(eq(agentConnectedAccounts.agentSlug, agentId))

      // Build account metadata (names + IDs, no tokens)
      const accountMetadata: Record<string, Array<{ name: string; id: string }>> = {}
      for (const { account } of accountMappings) {
        if (account.status !== 'active') continue
        if (!accountMetadata[account.toolkitSlug]) {
          accountMetadata[account.toolkitSlug] = []
        }
        accountMetadata[account.toolkitSlug].push({
          name: account.displayName,
          id: account.id,
        })
      }
      envVars['CONNECTED_ACCOUNTS'] = JSON.stringify(accountMetadata)

      // Pass host browser env vars if enabled
      const settings = getSettings()
      if (settings.app?.useHostBrowser) {
        envVars['AGENT_BROWSER_USE_HOST'] = '1'
        envVars['HOST_APP_URL'] = `http://${hostUrl}:${appPort}`
        envVars['AGENT_ID'] = agentId
      }

      // Copy Chrome profile data into workspace if configured
      const chromeProfileId = settings.app?.chromeProfileId
      if (chromeProfileId) {
        const workspaceDir = getAgentWorkspaceDir(agentId)
        const browserProfileDir = `${workspaceDir}/.browser-profile`
        if (copyChromeProfileData(chromeProfileId, browserProfileDir)) {
          console.log(`[ContainerManager] Copied Chrome profile "${chromeProfileId}" to workspace`)
        }
      }

      // Start container (user secrets are in .env file in workspace)
      await client.start({ envVars })

      // Sync status from Docker to get the actual port
      const info = await this.syncAgentStatus(agentId)

      // Record start time so auto-sleep monitor doesn't immediately
      // sleep the container based on stale session activity timestamps
      this.containerStartedAt.set(agentId, Date.now())

      // Broadcast agent status change globally
      messagePersister.broadcastGlobal({
        type: 'agent_status_changed',
        agentSlug: agentId,
        status: info.status,
      })
    }

    return client
  }

  // Get the time a container was started (used by auto-sleep monitor)
  getContainerStartTime(agentId: string): number | undefined {
    return this.containerStartedAt.get(agentId)
  }

  // Remove a client from the cache
  removeClient(agentId: string): void {
    this.clients.delete(agentId)
    this.containerStartedAt.delete(agentId)
    this.containerStatuses.delete(agentId)
    this.healthWarnings.delete(agentId)
  }

  // Clear all cached clients (e.g., when container runner setting changes).
  // Does NOT stop running containers — call stopAll() first if needed.
  clearClients(): void {
    this.clients.clear()
    this.containerStartedAt.clear()
    this.containerStatuses.clear()
    this.healthWarnings.clear()
  }

  // Stop all containers
  async stopAll(): Promise<void> {
    const agentIds = Array.from(this.clients.keys())
    const stopPromises = agentIds.map(async (agentId) => {
      try {
        await this.stopContainer(agentId)
      } catch (error) {
        console.error(`Failed to stop container for agent ${agentId}:`, error)
      }
    })
    await Promise.all(stopPromises)
    this.clients.clear()
    this.containerStartedAt.clear()
    this.containerStatuses.clear()
    this.healthWarnings.clear()
  }

  // Synchronous stop - used for exit handlers where async isn't available
  stopAllSync(): void {
    this.stopStatusSync() // Stop the sync interval
    this.stopHealthMonitor() // Stop the health monitor
    for (const [agentId, client] of this.clients.entries()) {
      try {
        client.stopSync()
        this.markAsStopped(agentId)
      } catch (error) {
        console.error(`Failed to stop container for agent ${agentId} (sync):`, error)
      }
    }
    this.clients.clear()
    this.containerStartedAt.clear()
    this.containerStatuses.clear()
    this.healthWarnings.clear()
  }

  // Check if any agents have running containers (uses cached status)
  hasRunningAgents(): boolean {
    for (const status of this.containerStatuses.values()) {
      if (status.status === 'running') {
        return true
      }
    }
    return false
  }

  // Get list of running agent IDs (uses cached status)
  getRunningAgentIds(): string[] {
    const running: string[] = []
    for (const [agentId, status] of this.containerStatuses.entries()) {
      if (status.status === 'running') {
        running.push(agentId)
      }
    }
    return running
  }

  /** Get the current runtime readiness state. */
  getReadiness(): RuntimeReadiness {
    return this._readiness
  }

  /** Update readiness state and broadcast change via SSE. */
  private setReadiness(readiness: RuntimeReadiness): void {
    this._readiness = readiness
    messagePersister.broadcastGlobal({
      type: 'runtime_readiness_changed',
      readiness,
    })
  }

  /**
   * Check runtime availability and image readiness.
   * Pulls the image if it doesn't exist locally.
   * Updates readiness state throughout and broadcasts via SSE.
   */
  async ensureImageReady(): Promise<void> {
    // In E2E mock mode, skip real runtime checks and report ready immediately
    if (process.env.E2E_MOCK === 'true') {
      this.setReadiness({
        status: 'READY',
        message: 'Ready (E2E mock)',
        pullProgress: null,
      })
      return
    }

    let settings = getSettings()
    const image = settings.container.agentImage

    // Step 1: Check configured runner availability
    // We check the *configured* runner specifically (not a fallback) because
    // createContainerClient() always uses the configured runner.
    let configuredRunner = settings.container.containerRunner as ContainerRunner

    this.setReadiness({
      status: 'CHECKING',
      message: `Checking ${configuredRunner} availability...`,
      pullProgress: null,
    })

    const allAvailability = await checkAllRunnersAvailability()
    const runnerStatus = allAvailability.find((r) => r.runner === configuredRunner)

    if (!runnerStatus?.available) {
      // Auto-start Apple Container runtime if it's installed but not running
      if (configuredRunner === 'apple-container' && runnerStatus?.installed && !runnerStatus?.running) {
        this.setReadiness({
          status: 'CHECKING',
          message: 'Starting Apple Container runtime...',
          pullProgress: null,
        })

        const startResult = await startRunner('apple-container')
        if (startResult.success) {
          // Poll for runtime to become available (up to ~15s)
          let available = false
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 1000))
            const refreshed = await refreshRunnerAvailability()
            const status = refreshed.find((r) => r.runner === 'apple-container')
            if (status?.available) {
              available = true
              break
            }
          }

          if (!available) {
            this.setReadiness({
              status: 'RUNTIME_UNAVAILABLE',
              message: 'Apple Container runtime failed to start in time.',
              pullProgress: null,
            })
            return
          }
          // Fall through to image check below
        } else {
          this.setReadiness({
            status: 'RUNTIME_UNAVAILABLE',
            message: `Failed to start Apple Container runtime: ${startResult.message}`,
            pullProgress: null,
          })
          return
        }
      } else {
        // Configured runner not available — check if another runner is available and auto-switch
        const alternativeRunner = allAvailability.find((r) => r.available && r.runner !== configuredRunner)
        if (alternativeRunner) {
          console.log(`Configured runner ${configuredRunner} not available, auto-switching to ${alternativeRunner.runner}`)
          configuredRunner = alternativeRunner.runner as ContainerRunner
          settings = { ...settings, container: { ...settings.container, containerRunner: configuredRunner } }
          updateSettings(settings)
        } else {
          const detail = !runnerStatus?.installed
            ? `${configuredRunner} is not installed.`
            : `${configuredRunner} is not running. Please start it and refresh.`
          this.setReadiness({
            status: 'RUNTIME_UNAVAILABLE',
            message: detail,
            pullProgress: null,
          })
          return
        }
      }
    }

    const effectiveRunner = configuredRunner

    // Step 2: Check if image exists
    this.setReadiness({
      status: 'CHECKING',
      message: `Checking if image ${image} exists...`,
      pullProgress: null,
    })

    const exists = await checkImageExists(effectiveRunner, image)

    if (exists) {
      this.setReadiness({
        status: 'READY',
        message: 'Ready',
        pullProgress: null,
      })
      return
    }

    // Step 3: Build or pull the image
    // In dev mode (agent-container directory exists), build locally.
    // In production (no build context), pull from registry.
    const shouldBuild = canBuildImage()
    const actionLabel = shouldBuild ? 'Building' : 'Pulling'

    this.setReadiness({
      status: 'PULLING_IMAGE',
      message: `${actionLabel} image ${image}...`,
      pullProgress: { status: `Starting ${actionLabel.toLowerCase()}...`, percent: null, completedLayers: 0, totalLayers: 0 },
    })

    let lastBroadcastTime = 0
    const THROTTLE_MS = 500

    try {
      const imageAction = shouldBuild ? buildImage : pullImage
      await imageAction(effectiveRunner, image, (progress) => {
        const now = Date.now()
        if (now - lastBroadcastTime >= THROTTLE_MS) {
          this.setReadiness({
            status: 'PULLING_IMAGE',
            message: `${actionLabel} image ${image}...`,
            pullProgress: progress,
          })
          lastBroadcastTime = now
        }
      })

      this.setReadiness({
        status: 'READY',
        message: 'Ready',
        pullProgress: null,
      })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      console.error(`[ContainerManager] Failed to ${actionLabel.toLowerCase()} image ${image}:`, errMsg)
      this.setReadiness({
        status: 'ERROR',
        message: `Failed to ${actionLabel.toLowerCase()} image: ${errMsg}`,
        pullProgress: null,
      })
    }
  }
}

// Export singleton instance
// Use globalThis to persist across hot reloads in development
const globalForManager = globalThis as unknown as {
  containerManager: ContainerManager | undefined
}

export const containerManager =
  globalForManager.containerManager ?? new ContainerManager()

if (process.env.NODE_ENV !== 'production') {
  globalForManager.containerManager = containerManager
}

// Note: Graceful shutdown handlers are registered in the application entry point
// (src/main/index.ts for Electron, src/web/server.ts for web)
// This avoids side effects at module import time and allows proper cleanup coordination

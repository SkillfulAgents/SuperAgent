import path from 'path'
import { createContainerClient, checkAllRunnersAvailability, checkImageExists, pullImage, canBuildImage, buildImage, startRunner, refreshRunnerAvailability, clearRunnerAvailabilityCache, getRunnerDisplayName, type ContainerRunner } from './client-factory'
import type { ContainerClient, ContainerConfig, ContainerInfo, HealthCheckResult, RuntimeReadiness } from './types'
import { healthMonitor } from './health-monitor'
import { db } from '@shared/lib/db'
import { agentConnectedAccounts, connectedAccounts, agentRemoteMcps, remoteMcpServers } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getOrCreateProxyToken } from '@shared/lib/proxy/token-store'
import { getContainerHostUrl, getAppPort } from '@shared/lib/proxy/host-url'
import { getSettings, updateSettings } from '@shared/lib/config/settings'
import { getAgentWorkspaceDir } from '@shared/lib/config/data-dir'
import { copyChromeProfileData } from '@shared/lib/browser/chrome-profile'
import { messagePersister } from './message-persister'
import { resolveTimezoneForAgent } from '@shared/lib/services/timezone-resolver'
import { getMountsWithHealth } from '@shared/lib/services/mount-service'

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
  /** Agents currently being stopped — skip health checks, sync, and connection error recovery */
  private stoppingAgents: Set<string> = new Set()

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
          // Skip if the agent is being stopped — don't spawn more CLI commands
          if (this.stoppingAgents.has(agentId)) return

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
   *
   * Marks the agent as "stopping" so health checks, status sync, and connection
   * error handlers stop spawning CLI commands into a potentially overloaded VM.
   */
  async stopContainer(agentId: string): Promise<void> {
    // Mark as stopping immediately to prevent health checks / sync from spawning
    // more CLI processes into an overloaded VM
    this.stoppingAgents.add(agentId)

    let forceStopUsed = false

    try {
      const client = this.getClient(agentId)
      const result = await client.stop()
      forceStopUsed = result.forceStopUsed
    } finally {
      this.stoppingAgents.delete(agentId)

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

      // If we had to force-kill the VM (e.g., Lima QEMU process):
      // 1. Mark ALL other running containers as stopped — they died with the VM
      // 2. Clear stale runner availability cache so ensureImageReady sees the dead VM
      // 3. Re-check runtime readiness so the VM restarts in the background
      if (forceStopUsed) {
        for (const otherId of this.getRunningAgentIds()) {
          if (otherId === agentId) continue
          this.markAsStopped(otherId)
          messagePersister.markAllSessionsInactiveForAgent(otherId)
          messagePersister.broadcastGlobal({
            type: 'agent_status_changed',
            agentSlug: otherId,
            status: 'stopped',
          })
        }

        // Alert the user that we had to kill the VM
        messagePersister.broadcastGlobal({
          type: 'system_alert',
          level: 'warning',
          title: 'Container runtime restarting',
          body: 'The agent was unresponsive and required force-stopping the container runtime. All running agents have been stopped. The runtime will restart automatically.',
        })

        clearRunnerAvailabilityCache()

        this.ensureImageReady().catch((err) => {
          console.error('[ContainerManager] Failed to re-check readiness after force stop:', err)
        })
      }
    }
  }

  /**
   * Restart a container by stopping and re-starting it.
   * Mounts are re-loaded from mounts.json on start.
   */
  async restartContainer(agentId: string): Promise<ContainerClient> {
    await this.stopContainer(agentId)
    return this.ensureRunning(agentId)
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
        // Skip agents currently being stopped
        if (this.stoppingAgents.has(agentId)) continue

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
        // Skip agents currently being stopped — don't spawn CLI commands into an overloaded VM
        if (this.stoppingAgents.has(agentId)) continue

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

      // Fetch remote MCPs for this agent
      const mcpMappings = await db
        .select({ mcp: remoteMcpServers })
        .from(agentRemoteMcps)
        .innerJoin(remoteMcpServers, eq(agentRemoteMcps.remoteMcpId, remoteMcpServers.id))
        .where(eq(agentRemoteMcps.agentSlug, agentId))

      const mcpConfigs = mcpMappings
        .filter(({ mcp }) => mcp.status === 'active')
        .map(({ mcp }) => {
          // Only pass tool names (not full schemas) to keep env var size small
          let toolNames: Array<{ name: string }> = []
          if (mcp.toolsJson) {
            try { toolNames = JSON.parse(mcp.toolsJson).map((t: any) => ({ name: t.name })) } catch { /* ignore */ }
          }
          return {
            id: mcp.id,
            name: mcp.name,
            proxyUrl: `http://${hostUrl}:${appPort}/api/mcp-proxy/${agentId}/${mcp.id}`,
            tools: toolNames,
          }
        })

      if (mcpConfigs.length > 0) {
        envVars['REMOTE_MCPS'] = JSON.stringify(mcpConfigs)
      }

      // Pass host browser env vars if a host browser provider is selected
      const settings = getSettings()
      if (settings.app?.hostBrowserProvider) {
        envVars['AGENT_BROWSER_USE_HOST'] = '1'
        envVars['HOST_APP_URL'] = `http://${hostUrl}:${appPort}`
        envVars['AGENT_ID'] = agentId
      }

      // Copy Chrome profile data into workspace if configured
      const chromeProfileId = settings.app?.chromeProfileId
      if (chromeProfileId) {
        const workspaceDir = getAgentWorkspaceDir(agentId)
        const browserProfileDir = path.join(workspaceDir, '.browser-profile')
        if (copyChromeProfileData(chromeProfileId, browserProfileDir)) {
          console.log(`[ContainerManager] Copied Chrome profile "${chromeProfileId}" to workspace`)
        }
      }

      // Set container timezone to the agent owner's timezone
      const tz = resolveTimezoneForAgent(agentId)
      envVars['TZ'] = tz

      // Inject user-defined custom env vars (set in global settings)
      if (settings.customEnvVars) {
        Object.assign(envVars, settings.customEnvVars)
      }

      // Load mounts and build volume flags for healthy ones
      const mountsWithHealth = getMountsWithHealth(agentId)
      const healthyMounts = mountsWithHealth.filter((m) => m.health === 'ok')
      const missingMounts = mountsWithHealth.filter((m) => m.health === 'missing')

      if (missingMounts.length > 0) {
        console.warn(`[ContainerManager] Skipping ${missingMounts.length} missing mount(s) for ${agentId}:`, missingMounts.map((m) => m.hostPath))
        messagePersister.broadcastGlobal({
          type: 'mount_health_warning',
          agentSlug: agentId,
          missingMounts: missingMounts.map((m) => ({ folderName: m.folderName, hostPath: m.hostPath })),
        })
      }

      const additionalVolumes = healthyMounts.map((m) =>
        client.buildVolumeFlag(m.hostPath, m.containerPath)
      )

      // Start container (user secrets are in .env file in workspace)
      await client.start({ envVars, additionalVolumes })

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
    this.stoppingAgents.delete(agentId)
  }

  // Clear all cached clients (e.g., when container runner setting changes).
  // Does NOT stop running containers — call stopAll() first if needed.
  clearClients(): void {
    this.clients.clear()
    this.containerStartedAt.clear()
    this.containerStatuses.clear()
    this.healthWarnings.clear()
    this.stoppingAgents.clear()
  }

  // Stop all containers (with per-container timeout to prevent blocking shutdown)
  async stopAll(): Promise<void> {
    // Timeout must accommodate the full escalation chain:
    // nerdctl stop (10s) + nerdctl kill (5s) + forceStop (10s) = 25s max
    const STOP_TIMEOUT_MS = 30000
    const agentIds = Array.from(this.clients.keys())
    const stopPromises = agentIds.map(async (agentId) => {
      try {
        await Promise.race([
          this.stopContainer(agentId),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Container stop timed out')), STOP_TIMEOUT_MS)
          ),
        ])
      } catch (error) {
        console.error(`Failed to stop container for agent ${agentId}:`, error)
      }
    })
    await Promise.all(stopPromises)
    this.clients.clear()
    this.containerStartedAt.clear()
    this.containerStatuses.clear()
    this.healthWarnings.clear()
    this.stoppingAgents.clear()
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

  /** Reset readiness to CHECKING state and broadcast. Used when restarting a runtime.
   *  Skips reset if an image pull is in progress to avoid losing pull progress UI. */
  resetReadiness(message = 'Restarting runtime...'): void {
    if (this._readiness.status === 'PULLING_IMAGE') {
      return
    }
    this.setReadiness({
      status: 'CHECKING',
      message,
      pullProgress: null,
    })
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
      message: `Checking ${getRunnerDisplayName(configuredRunner)} availability...`,
      pullProgress: null,
    })

    const allAvailability = await checkAllRunnersAvailability()
    const runnerStatus = allAvailability.find((r) => r.runner === configuredRunner)

    if (!runnerStatus?.available) {
      // Auto-start runtimes that support it (Apple Container, Lima, WSL2)
      if ((configuredRunner === 'apple-container' || configuredRunner === 'lima' || configuredRunner === 'wsl2') && runnerStatus?.installed && !runnerStatus?.running) {
        this.setReadiness({
          status: 'CHECKING',
          message: `Starting ${getRunnerDisplayName(configuredRunner)} runtime...`,
          pullProgress: null,
        })

        const startResult = await startRunner(configuredRunner)
        if (startResult.success) {
          // Poll for runtime to become available
          // Lima VM / WSL2 distro boot can take up to ~30s, Apple Container ~15s
          const maxPollSeconds = (configuredRunner === 'lima' || configuredRunner === 'wsl2') ? 60 : 15
          let available = false
          for (let i = 0; i < maxPollSeconds; i++) {
            await new Promise((r) => setTimeout(r, 1000))
            const refreshed = await refreshRunnerAvailability()
            const status = refreshed.find((r) => r.runner === configuredRunner)
            if (status?.available) {
              available = true
              break
            }
          }

          if (!available) {
            this.setReadiness({
              status: 'RUNTIME_UNAVAILABLE',
              message: `${getRunnerDisplayName(configuredRunner)} runtime failed to start in time.`,
              pullProgress: null,
            })
            return
          }
          // Fall through to image check below
        } else {
          this.setReadiness({
            status: 'RUNTIME_UNAVAILABLE',
            message: `Failed to start ${getRunnerDisplayName(configuredRunner)} runtime: ${startResult.message}`,
            pullProgress: null,
          })
          return
        }
      } else {
        // Configured runner not available — check if another runner is already running and auto-switch
        const alternativeRunner = allAvailability.find((r) => r.available && r.runner !== configuredRunner)
        if (alternativeRunner) {
          console.log(`Configured runner ${configuredRunner} not available, auto-switching to ${alternativeRunner.runner}`)
          configuredRunner = alternativeRunner.runner as ContainerRunner
          settings = { ...settings, container: { ...settings.container, containerRunner: configuredRunner } }
          updateSettings(settings)
        } else {
          const displayName = getRunnerDisplayName(configuredRunner)
          const detail = !runnerStatus?.installed
            ? `${displayName} is not installed.`
            : `${displayName} is not running. Please start it and refresh.`
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

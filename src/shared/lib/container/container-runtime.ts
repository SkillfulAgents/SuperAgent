/**
 * One agent's container on this machine: its client, cached status, start and
 * stop, health warnings, and recovery from an unexpected death.
 *
 * The container host owns one of these per agent and the agent actor reaches
 * it through the host. Nothing else imports this module. A runtime knows only
 * its own agent; what needs the whole fleet (readiness, image pulls, the sync
 * and health loops, force-stop fallout) is the host's, reached through
 * `RuntimeHost`.
 */
import path from 'path'
import { createContainerClient } from './client-factory'
import type {
  ContainerClient,
  ContainerConfig,
  ContainerInfo,
  HealthCheckResult,
  StopOptions,
} from './types'
import { healthMonitor } from './health-monitor'
import { db } from '@shared/lib/db'
import { agentConnectedAccounts, connectedAccounts, agentRemoteMcps, remoteMcpServers } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getOrCreateProxyToken } from '@shared/lib/proxy/token-store'
import { getOrCreateHostToken } from '@shared/lib/container/host-token-store'
import { getSettings } from '@shared/lib/config/settings'
import { getAgentWorkspaceDir } from '@shared/lib/config/data-dir'
import { copyChromeProfileData } from '@shared/lib/browser/chrome-profile'
import { messagePersister } from './message-persister'
import { ungrabAC } from '@shared/lib/computer-use/executor'
import { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import { captureException } from '@shared/lib/error-reporting'
import { resolveTimezoneForAgent } from '@shared/lib/services/timezone-resolver'
import { getMountsWithHealth } from '@shared/lib/services/mount-service'
import { isPlatformComposioActive } from '@shared/lib/composio/client'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { mergeCustomEnvVars } from './reserved-env-vars'
import {
  buildConnectedAccountsProjection,
  buildRemoteMcpProjection,
} from './connection-runtime-projections'
import { recoverFromUnexpectedDeath } from './runtime-recovery'

/**
 * Max age (in ms) of a cached 'running' status before ensureRunning re-verifies
 * liveness with a /health round-trip. The cache has no TTL of its own, so a
 * container that died externally would otherwise report 'running' forever and
 * the next sendMessage/createSession would throw "Container is not running".
 * Default: 10 seconds — short enough to catch external death between requests,
 * long enough to avoid a health probe on every back-to-back message. */
const RUNNING_STATUS_TTL_MS = parseInt(
  process.env.CONTAINER_RUNNING_STATUS_TTL_SECONDS || '10',
  10
) * 1000

/** Cached container status */
interface CachedContainerStatus {
  status: 'running' | 'stopped'
  port: number | null
  lastSyncedAt: number
}

/** What a runtime needs from the host it belongs to. */
export interface RuntimeHost {
  /** Runs before a container is stopped (e.g. to close the host browser). */
  readonly onBeforeContainerStop: ((slug: string) => Promise<void>) | null
  /**
   * A stop had to force-kill the shared runtime VM, so every other container
   * died with it. The host marks them stopped, alerts the user, and re-checks
   * readiness so the VM restarts.
   */
  afterForceStop(slug: string): void
}

export class ContainerRuntime {
  private client: ContainerClient | null = null
  /** Cached container status - avoids repeated docker inspect calls */
  private cached: CachedContainerStatus | null = null
  private startedAt: number | undefined
  private lastKeepAlive: number | undefined
  /** Cached health warnings */
  private healthWarnings: HealthCheckResult[] = []
  /** Being stopped — skip health checks, sync, and connection error recovery */
  private stopping = false
  /** In-flight ensureRunning promise — deduplicates concurrent start requests */
  private starting: Promise<ContainerClient> | null = null
  /**
   * Dropped by the host. The client this runtime handed out may still be held
   * elsewhere (the persister's stream subscriptions, a stop in flight) and its
   * callbacks land here; a disposed runtime answers none of them, so a
   * container dying after the eviction cannot start recovery through a runtime
   * the host no longer knows about.
   */
  private disposed = false

  constructor(
    readonly slug: string,
    private readonly host: RuntimeHost,
  ) {}

  /** Get or create the container client. */
  getClient(): ContainerClient {
    if (!this.client) {
      const config: ContainerConfig = {
        agentId: this.slug,
        onConnectionError: () => {
          if (this.disposed) return
          if (this.stopping) return
          if (this.starting) return
          // No pre-snapshot here: the orchestrator snapshots synchronously, and
          // a join during an in-flight recovery queues a re-run that catches
          // sessions that became active in between.
          this.handleUnexpectedDeath()
        },
        // MicroVM dead-generation replace (and similar) must restart through the
        // runtime so starts share the in-flight promise and rebuild env from the DB.
        restartAgent: () => (this.disposed ? Promise.resolve() : this.restartAgent()),
      }

      this.client = createContainerClient(config)
    }

    return this.client
  }

  /** Whether a client has been created (the container has been touched). */
  hasClient(): boolean {
    return this.client !== null
  }

  /**
   * Forget the client and nothing else: the next getClient() builds one for
   * the runner configured then. A start in flight keeps the client it was
   * handed and still records its outcome here.
   */
  resetClient(): void {
    this.client = null
  }

  isStopping(): boolean {
    return this.stopping
  }

  isStarting(): boolean {
    return this.starting !== null
  }

  handleUnexpectedDeath(restrictToSessionIds?: string[]): void {
    if (this.disposed) return
    const slug = this.slug
    void recoverFromUnexpectedDeath({
      agentId: slug,
      isStopping: () => this.stopping,
      getClient: () => this.getClient(),
      restartAgent: () => this.restartAgent(),
      ensureRunning: () => this.ensureRunning(),
      snapshotMidTurnSessions: (agentId, restrict) => messagePersister.snapshotMidTurnSessions(agentId, restrict),
      consumeLastFatal: (agentId) => messagePersister.consumeLastFatal(agentId),
      settleRecoveringSessions: (ids) => messagePersister.settleRecoveringSessions(slug, ids),
      markRecovered: (ids) => messagePersister.markRecovered(slug, ids),
      takeCoalescedUserMessages: (id) => messagePersister.takeCoalescedUserMessages(slug, id),
      isSessionRecovering: (id) => messagePersister.isSessionRecovering(slug, id),
      isSubscribed: (id) => messagePersister.isSubscribed(slug, id),
      subscribeToSession: (sessionId, client, containerSessionId) =>
        // Recovery only ever resubscribes THIS agent's sessions, so the slug is
        // this runtime's — never a value the caller could disagree with.
        messagePersister.subscribeToSession(slug, sessionId, client, containerSessionId),
      restrictToSessionIds,
      syncAgentStatus: async () => {
        try {
          await this.syncAgentStatus()
        } catch (err) {
          console.error(`[ContainerRuntime] Failed to sync status after connection error:`, err)
          this.markAsStopped()
          messagePersister.markAllSessionsInactiveForAgent(slug)
          messagePersister.broadcastGlobal({
            type: 'agent_status_changed',
            agentSlug: slug,
            status: 'stopped',
          })
        }
      },
    }).catch((err) => {
      console.error(`[ContainerRuntime] Unexpected-death recovery failed for ${slug}:`, err)
      captureException(err, {
        tags: { area: 'container', op: 'runtime.recover.unhandled' },
        extra: { agentId: slug },
      })
    })
  }

  private assertNotStopping(op: 'start' | 'restart'): void {
    if (this.stopping) {
      throw new Error(`Cannot ${op} agent ${this.slug} while it is stopping`)
    }
  }

  // Single-flight restart used by runtime clients that tear down a dead generation.
  private async restartAgent(): Promise<void> {
    this.assertNotStopping('restart')
    if (this.starting) {
      await this.starting
      return
    }

    this.markAsStopped()
    // Dead generation had live sessions; clear isActive before the new start
    // (same as stopContainer — replace does not go through stopContainer).
    messagePersister.markAllSessionsInactiveForAgent(this.slug)
    messagePersister.broadcastGlobal({
      type: 'agent_status_changed',
      agentSlug: this.slug,
      status: 'stopped',
    })
    const client = this.getClient()
    const startPromise = this.doStartContainer(client)
    this.starting = startPromise
    try {
      await startPromise
    } finally {
      this.starting = null
    }
  }

  /**
   * Get cached container info. Returns cached status if available,
   * otherwise returns stopped (will be corrected on next sync).
   */
  getCachedInfo(): ContainerInfo {
    if (this.cached) {
      return { status: this.cached.status, port: this.cached.port }
    }
    // Default to stopped if not in cache
    return { status: 'stopped', port: null }
  }

  /**
   * Update cached container status. Called after start/stop operations.
   */
  updateCachedStatus(status: 'running' | 'stopped', port: number | null): void {
    this.cached = { status, port, lastSyncedAt: Date.now() }
  }

  /**
   * Mark the container as stopped in cache (e.g., when connection fails).
   * Prefer using stopContainer() which also stops the actual container.
   */
  markAsStopped(): void {
    this.updateCachedStatus('stopped', null)
    this.startedAt = undefined
    this.lastKeepAlive = undefined
  }

  /**
   * Stop the container and update all related state.
   * This is the preferred way to stop a container - handles cache, broadcasts, and session state.
   *
   * Marks the runtime as "stopping" so health checks, status sync, and connection
   * error handlers stop spawning CLI commands into a potentially overloaded VM.
   */
  async stopContainer(options?: StopOptions): Promise<void> {
    const slug = this.slug
    // Mark as stopping immediately to prevent health checks / sync from spawning
    // more CLI processes into an overloaded VM
    this.stopping = true
    this.starting = null

    let forceStopUsed = false
    // Default true: if stop() throws, preserve prior behavior of marking the
    // agent stopped. Only the explicit force-stop-disabled bail returns false.
    let stopped = true

    try {
      // Stop the host browser before the container so it closes gracefully
      // instead of getting a "socket hang up" when the container dies
      const beforeStop = this.host.onBeforeContainerStop
      if (beforeStop) {
        await beforeStop(slug).catch((err) => {
          console.warn(`[ContainerRuntime] Pre-stop hook failed for ${slug}:`, err)
        })
      }

      const client = this.getClient()
      const result = await client.stop(options)
      forceStopUsed = result.forceStopUsed
      // Only an explicit `false` (stop+kill timed out with force-stop disabled)
      // means the container is still running; anything else counts as stopped.
      stopped = result.stopped ?? true
    } finally {
      this.stopping = false

      if (!stopped) {
        // stop+kill timed out and force-stop was disabled (auto-sleep): the
        // container is still running. Leave cached status untouched so the UI
        // and the next auto-sleep sweep see reality, and skip the stopped-side
        // effects below.
        console.warn(
          `[ContainerRuntime] Stop incomplete for ${slug}; container still running, will retry next cycle`
        )
      } else {
        // Update cached status
        this.markAsStopped()

        // Mark all sessions for this agent as inactive
        messagePersister.markAllSessionsInactiveForAgent(slug, { settleRecovering: true })

        // If this agent had grabbed a window, ungrab it so the halo disappears
        if (computerUsePermissionManager.getGrabbedApp(slug)) {
          computerUsePermissionManager.clearGrabbedApp(slug)
          ungrabAC().catch(() => {})  // Best-effort, non-blocking
        }

        // Broadcast status change so UI updates
        messagePersister.broadcastGlobal({
          type: 'agent_status_changed',
          agentSlug: slug,
          status: 'stopped',
        })
      }

      // If we had to force-kill the VM (e.g., Lima QEMU process), every other
      // container died with it: the host marks them stopped, alerts the user,
      // and re-checks readiness so the VM restarts in the background.
      if (forceStopUsed) {
        this.host.afterForceStop(slug)
      }
    }
  }

  /**
   * Restart the container by stopping and re-starting it.
   * Mounts are re-loaded from mounts.json on start.
   */
  async restartContainer(): Promise<ContainerClient> {
    await this.stopContainer()
    return this.ensureRunning()
  }

  /**
   * Sync this agent's status with reality by querying the runtime.
   * Broadcasts status change if the actual status differs from cached.
   */
  async syncAgentStatus(): Promise<ContainerInfo> {
    const slug = this.slug
    const client = this.getClient()
    const previousStatus = this.cached?.status
    const info = await client.getInfoFromRuntime()

    // Don't update cache while a start is in-flight — Docker may report "running"
    // before the container's HTTP server is ready (health check hasn't passed yet)
    if (this.starting) return info

    this.updateCachedStatus(info.status, info.port)

    // Host restart clears in-memory start times. Floor the idle clock at
    // rediscovery so zero-session warm containers are still reaped.
    if (info.status === 'running' && this.startedAt === undefined) {
      this.startedAt = Date.now()
    }

    // Broadcast if status changed (e.g., container was stopped externally)
    if (previousStatus && previousStatus !== info.status) {
      console.log(`[ContainerRuntime] Status changed for ${slug}: ${previousStatus} -> ${info.status}`)
      messagePersister.broadcastGlobal({
        type: 'agent_status_changed',
        agentSlug: slug,
        status: info.status,
      })

      // If container stopped, mark sessions as inactive
      if (info.status === 'stopped') {
        messagePersister.markAllSessionsInactiveForAgent(slug)
      }
    }

    return info
  }

  /**
   * Run one health check against the running container and broadcast when
   * the warnings changed. Skipped while stopping or before any client exists.
   */
  async runHealthCheck(): Promise<void> {
    // Don't spawn CLI commands into an overloaded VM while it is being stopped
    if (this.stopping) return
    if (!this.client) return

    const stats = await this.client.getStats()
    if (!stats) return

    const warnings = healthMonitor.checkAll(this.slug, stats)
    const previous = this.healthWarnings

    // Broadcast only if warnings changed
    const changed = warnings.length !== previous.length ||
      warnings.some((w, i) => w.status !== previous[i]?.status || w.checkName !== previous[i]?.checkName)

    this.healthWarnings = warnings

    if (changed) {
      messagePersister.broadcastGlobal({
        type: 'container_health_changed',
        agentSlug: this.slug,
        warnings,
      })
    }
  }

  /**
   * Get cached health warnings.
   */
  getHealthWarnings(): HealthCheckResult[] {
    return this.healthWarnings
  }

  // Ensure the container is running, starting it with connected accounts if needed
  // Returns the container client
  //
  // Note: User secrets are stored in the .env file in the workspace,
  // not passed as env vars. Only connected account tokens are injected.
  async ensureRunning(): Promise<ContainerClient> {
    const slug = this.slug
    this.assertNotStopping('start')
    if (this.starting) return this.starting

    const client = this.getClient()
    const cached = this.cached

    // Treat the cached 'running' status as authoritative only while it's fresh.
    // The cache has no liveness check, so a container that died externally would
    // keep reporting 'running'. Once the cached status ages past the TTL,
    // re-verify with a single /health round-trip before trusting it; if the
    // probe fails, fall through to (re)start.
    let needsStart = !cached || cached.status !== 'running'
    if (!needsStart && cached && Date.now() - cached.lastSyncedAt > RUNNING_STATUS_TTL_MS) {
      const healthy = await client.isHealthy(cached.port ?? undefined)
      this.assertNotStopping('start')
      if (healthy) {
        // Still alive — refresh the timestamp so we don't re-probe every request.
        this.updateCachedStatus('running', cached.port)
      } else {
        console.warn(`[ContainerRuntime] Cached 'running' status for ${slug} failed liveness check, (re)starting`)
        this.markAsStopped()
        needsStart = true
      }
    }

    if (needsStart) {
      // The liveness probe above is an await point, so another ensureRunning
      // call may have kicked off a start while we were probing. Re-check the
      // in-flight dedupe before starting so a liveness-triggered restart can't
      // double-start the container.
      this.assertNotStopping('start')
      if (this.starting) return this.starting

      const startPromise = this.doStartContainer(client)
      this.starting = startPromise
      try {
        await startPromise
      } finally {
        this.starting = null
      }
    }

    return client
  }

  private async doStartContainer(client: ContainerClient): Promise<ContainerClient> {
    const slug = this.slug
    // Pass proxy config and account metadata (no raw tokens)
    const envVars: Record<string, string> = {}

    // Set up proxy authentication
    const proxyToken = await getOrCreateProxyToken(slug)
    const hostApiBaseUrl = await client.getHostApiBaseUrl()
    envVars['PROXY_BASE_URL'] = `${hostApiBaseUrl}/api/proxy/${slug}`
    envVars['PROXY_TOKEN'] = proxyToken

    // X-Agent Work: cross-agent calls. Container POSTs to host with PROXY_TOKEN.
    envVars['SUPERAGENT_HOST_API_URL'] = `${hostApiBaseUrl}/api`
    envVars['SUPERAGENT_AGENT_SLUG'] = slug

    // Authenticates the HOST to the container API (the reverse direction of
    // PROXY_TOKEN, which the agent legitimately holds). The container server
    // strips this from its env before spawning the CLI.
    envVars['SUPERAGENT_HOST_TOKEN'] = getOrCreateHostToken(slug)

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
      .where(eq(agentConnectedAccounts.agentSlug, slug))

    // Build account metadata (names + IDs, no tokens)
    const accountMetadata = buildConnectedAccountsProjection(
      accountMappings.map(({ account }) => account),
    )
    envVars['CONNECTED_ACCOUNTS'] = JSON.stringify(accountMetadata)

    // Fetch remote MCPs for this agent
    const mcpMappings = await db
      .select({ mcp: remoteMcpServers })
      .from(agentRemoteMcps)
      .innerJoin(remoteMcpServers, eq(agentRemoteMcps.remoteMcpId, remoteMcpServers.id))
      .where(eq(agentRemoteMcps.agentSlug, slug))

    const mcpConfigs = buildRemoteMcpProjection(
      mcpMappings.map(({ mcp }) => mcp),
      slug,
      hostApiBaseUrl,
    )

    if (mcpConfigs.length > 0) {
      envVars['REMOTE_MCPS'] = JSON.stringify(mcpConfigs)
    }

    // Pass host browser env vars if a host browser provider is selected
    const settings = getSettings()
    if (settings.app?.hostBrowserProvider) {
      envVars['AGENT_BROWSER_USE_HOST'] = '1'
      envVars['HOST_APP_URL'] = hostApiBaseUrl
      envVars['AGENT_ID'] = slug
    }

    // Seed the built-in container browser from the selected Chrome profile.
    // A host-browser provider uses its own dedicated profile, so copying the
    // same data into the mounted workspace would only delay container start.
    const chromeProfileId = settings.app?.chromeProfileId
    if (chromeProfileId && !settings.app?.hostBrowserProvider) {
      const workspaceDir = getAgentWorkspaceDir(slug)
      const browserProfileDir = path.join(workspaceDir, '.browser-profile')
      if (await copyChromeProfileData(chromeProfileId, browserProfileDir)) {
        console.log(`[ContainerRuntime] Synchronized Chrome profile "${chromeProfileId}" to workspace`)
      }
    }

    // Set container timezone to the agent owner's timezone
    const tz = resolveTimezoneForAgent(slug)
    envVars['TZ'] = tz

    // Tell the agent container which host OS is running (for script type selection)
    envVars['HOST_PLATFORM'] = process.platform

    // Enable Composio webhook trigger tools when platform Composio is active
    if (isPlatformComposioActive()) {
      envVars['COMPOSIO_PLATFORM_MODE'] = 'true'
    }

    // Custom webhook endpoints live on the platform proxy, not Composio: a
    // user with platform auth plus a personal Composio key must still get
    // the endpoint tools (mirrors the teardown gate in
    // webhook-trigger-service).
    if (getPlatformAccessToken()) {
      envVars['PLATFORM_AUTH_ACTIVE'] = 'true'
    }

    // Inject user-defined custom env vars (set in global settings). Reserved
    // runtime keys are skipped so custom config can never clobber required
    // wiring (proxy auth, agent identity, connected accounts, etc.). See
    // reserved-env-vars.ts.
    mergeCustomEnvVars(envVars, settings.customEnvVars)

    envVars['CLAUDE_CODE_ATTRIBUTION_HEADER'] = '0'

    // Load mounts and build volume flags for healthy ones
    const mountsWithHealth = await getMountsWithHealth(slug)
    const healthyMounts = mountsWithHealth.filter((m) => m.health === 'ok')
    const missingMounts = mountsWithHealth.filter((m) => m.health === 'missing')

    if (missingMounts.length > 0) {
      console.warn(`[ContainerRuntime] Skipping ${missingMounts.length} missing mount(s) for ${slug}:`, missingMounts.map((m) => m.hostPath))
      messagePersister.broadcastGlobal({
        type: 'mount_health_warning',
        agentSlug: slug,
        missingMounts: missingMounts.map((m) => ({ folderName: m.folderName, hostPath: m.hostPath })),
      })
    }

    const additionalVolumes = healthyMounts.map((m) =>
      client.buildVolumeFlag(m.hostPath, m.containerPath)
    )

    // The prompt lists the mounted folders. A mount the runtime drops at run
    // time (below) is still listed; the warning banner covers that case.
    if (healthyMounts.length > 0) {
      envVars['SUPERAGENT_MOUNTS'] = JSON.stringify(healthyMounts.map((m) => m.containerPath))
    }

    // Start container (user secrets are in .env file in workspace).
    // If a mount turns out to be inaccessible to the container runtime at run
    // time (e.g. a cloud-synced folder the Lima VM helper is denied — passes
    // the host health check but fails EPERM-on-stat inside the VM), start()
    // drops that one mount and the container still comes up. Surface the same
    // mount-health warning banner with a macOS-specific hint instead of
    // failing the whole agent.
    const startedInfo = await client.start({
      envVars,
      additionalVolumes,
      onMountDropped: (hostPath) => {
        const dropped = healthyMounts.find((m) => m.hostPath === hostPath)
        console.warn(`[ContainerRuntime] Mount inaccessible to runtime, dropped for ${slug}: ${hostPath}`)
        messagePersister.broadcastGlobal({
          type: 'mount_health_warning',
          agentSlug: slug,
          missingMounts: [{ folderName: dropped?.folderName ?? hostPath, hostPath }],
          hint: process.platform === 'darwin'
            ? 'This folder is in iCloud Drive or a cloud-synced location, which can’t be shared into the agent sandbox. Move it to a regular local folder.'
            : undefined,
        })
      },
    })

    // Stop won the race: do not cache/broadcast running for a port about to die.
    this.assertNotStopping('start')

    // start() returns the port that just passed the runtime's health gate,
    // so don't immediately spawn another inspect/API request for the same
    // state. The runtime-query fallback covers clients that omit the
    // return, which the ContainerClient contract still allows. (Can't use
    // syncAgentStatus here — it is guarded against updates during startup.)
    const info = startedInfo ?? await client.getInfoFromRuntime()
    this.updateCachedStatus(info.status, info.port)

    // Record start time so auto-sleep monitor doesn't immediately
    // sleep the container based on stale session activity timestamps
    this.startedAt = Date.now()

    // Broadcast agent status change globally
    messagePersister.broadcastGlobal({
      type: 'agent_status_changed',
      agentSlug: slug,
      status: info.status,
    })

    return client
  }

  // Get the time the container was started (used by auto-sleep monitor)
  getContainerStartTime(): number | undefined {
    return this.startedAt
  }

  // Record a keep-alive ping (e.g. from an open dashboard) to prevent auto-sleep
  keepAlive(): void {
    this.lastKeepAlive = Date.now()
  }

  getLastKeepAlive(): number | undefined {
    return this.lastKeepAlive
  }

  /**
   * Forget the client and every cached fact about the container. Does not
   * stop the container.
   */
  dispose(): void {
    this.disposed = true
    this.client = null
    this.cached = null
    this.startedAt = undefined
    this.lastKeepAlive = undefined
    this.healthWarnings = []
    this.stopping = false
    this.starting = null
  }

  /**
   * Synchronous stop for exit handlers where async isn't available. A runtime
   * that never created a client has nothing to stop.
   */
  stopSync(): void {
    if (!this.client) return
    try {
      this.client.stopSync()
      this.markAsStopped()
    } catch (error) {
      console.error(`Failed to stop container for agent ${this.slug} (sync):`, error)
    }
  }
}

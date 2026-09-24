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
import { createContainerClient } from './client-factory'
import { ActivityClock } from './activity-clock'
import { IdleAlarm } from './idle-alarm'
import type {
  ContainerClient,
  ContainerConfig,
  ContainerInfo,
  HealthCheckResult,
  StopOptions,
} from './types'
import { healthMonitor } from './health-monitor'
import { db } from '@shared/lib/db'
import { agentConnectedAccounts, connectedAccounts } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getOrCreateProxyToken } from '@shared/lib/proxy/token-store'
import { getOrCreateHostToken } from '@shared/lib/container/host-token-store'
import { getSettings } from '@shared/lib/config/settings'
import { seedBrowserProfileFromChrome } from '@shared/lib/browser/seed-browser-profile'
import { displayNameFromInstructions } from '@shared/lib/utils/agent-display-name'
import type { AgentWorkspaceAccess } from './agent-workspace-access'
import { messagePersister } from './message-persister'
import { ungrabAC } from '@shared/lib/computer-use/executor'
import { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import { captureException } from '@shared/lib/error-reporting'
import { resolveTimezoneForAgent } from '@shared/lib/services/timezone-resolver'
import { getMountsWithHealth } from '@shared/lib/services/mount-service'
import { isPlatformComposioActive } from '@shared/lib/composio/client'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getWebhookRelay } from '@shared/lib/webhook-relay'
import { mergeCustomEnvVars } from './reserved-env-vars'
import { buildConnectedAccountsProjection, listAgentMcpConnections } from './connection-runtime-projections'
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
  /**
   * The agents' workspaces, for what a start needs from them: the browser
   * profile seeding and the display name. Null only before the agent
   * registry attached it, which in the app is never.
   */
  readonly agentWorkspaces: AgentWorkspaceAccess | null
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
  /**
   * When this container was last busy: its start, the last keep-alive, the
   * last session activity. Every mark re-arms the idle alarm; nothing here
   * touches the filesystem.
   */
  private readonly activity = new ActivityClock()
  /**
   * Puts the container to sleep once it has been idle for the auto-sleep
   * timeout. Armed from the marks above, cancelled when the container stops
   * or the runtime is dropped; the host re-arms it when the timeout changes.
   */
  readonly idleAlarm = new IdleAlarm({
    timeoutMs: () => (getSettings().app?.autoSleepTimeoutMinutes ?? 30) * 60_000,
    lastActivityAt: () => this.sleepableSince(),
    isBusy: () => this.isBusy(),
    sleep: () => this.sleepIdle(),
  })
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
  /**
   * Running on a container env that a setting change replaced. The host marks
   * every running runtime when a platform token changes; a stop clears it.
   */
  private stale = false
  /**
   * Whether webhooks could be received when this process built the
   * container's env (WEBHOOK_RELAY_AVAILABLE); null until it has.
   */
  private webhookRelayAtStart: boolean | null = null

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
    await this.trackStart(this.doStartContainer(client))
  }

  /**
   * Hold a start as the in-flight one until it settles, then arm the idle
   * alarm: a mark made while the start was in flight (the start's own, or a
   * session write) could not arm it, since the alarm is inert during a start.
   * A start that failed leaves the container not running, so arming is a no-op.
   */
  private async trackStart(startPromise: Promise<ContainerClient>): Promise<void> {
    this.starting = startPromise
    try {
      await startPromise
    } finally {
      this.starting = null
      this.idleAlarm.schedule()
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
    if (status === 'stopped') {
      this.stale = false
      this.webhookRelayAtStart = null
    }
  }

  markStale(): void {
    this.stale = true
  }

  /**
   * Goes stale when the container's webhook tools no longer match whether
   * webhooks can be received. A container this process didn't start is
   * assumed to match the first availability it sees.
   */
  reconcileWebhookRelay(available: boolean): void {
    if (this.webhookRelayAtStart === null) this.webhookRelayAtStart = available
    else if (this.webhookRelayAtStart !== available) this.stale = true
  }

  isStale(): boolean {
    return this.stale
  }

  /**
   * Mark the container as stopped in cache (e.g., when connection fails).
   * Prefer using stopContainer() which also stops the actual container.
   */
  markAsStopped(): void {
    this.updateCachedStatus('stopped', null)
    this.activity.reset()
    this.idleAlarm.cancel()
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

    if (info.status === 'running') {
      // Host restart clears in-memory start times. Floor the idle clock at
      // rediscovery so zero-session warm containers are still reaped.
      if (!this.activity.hasStarted()) this.activity.started()
      // Arm from the last mark whether or not the clock was floored just now:
      // an alarm that fired while a sync (or a transient inspect failure)
      // reported the container stopped found nothing to sleep and disarmed,
      // and the marks it would have re-armed from are still on the clock.
      this.idleAlarm.schedule()
    } else {
      // Nothing to sleep while the container is not observed running. The
      // marks stay: if the report was a transient failure, the next running
      // sync arms from them again rather than from a fresh floor.
      this.idleAlarm.cancel()
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

      await this.trackStart(this.doStartContainer(client))
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

    const mcpConfigs = await listAgentMcpConnections(slug, hostApiBaseUrl)

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

    // What the start needs from the agent's workspace goes through the
    // agent's file operations, never a host path: the workspace is wherever
    // the agent's actor says it is.
    let agentName: string | undefined
    const workspaces = this.host.agentWorkspaces
    if (workspaces) {
      // Seed the built-in container browser from the selected Chrome profile.
      // A failure fails the start, as a failed copy always did.
      await seedBrowserProfileFromChrome(slug, workspaces.files(slug))
      // The display name is attribution only; a start without it is still a start.
      try {
        agentName = displayNameFromInstructions(await workspaces.instructions(slug))
      } catch (error) {
        console.warn(`[ContainerRuntime] Could not read the display name for ${slug}; starting without it:`, error)
      }
    }

    // Set container timezone to the agent owner's timezone
    const tz = await resolveTimezoneForAgent(slug)
    envVars['TZ'] = tz

    // Tell the agent container which host OS is running (for script type selection)
    envVars['HOST_PLATFORM'] = process.platform

    // Enable Composio webhook trigger tools when platform Composio is active
    if (isPlatformComposioActive()) {
      envVars['COMPOSIO_PLATFORM_MODE'] = 'true'
    }

    // Webhook tools (custom endpoints, and Composio triggers with the flag
    // above) follow the relay, not Composio mode: a personal Composio key
    // must not take the endpoint tools away.
    this.webhookRelayAtStart = getWebhookRelay().snapshot().available
    if (this.webhookRelayAtStart) {
      envVars['WEBHOOK_RELAY_AVAILABLE'] = 'true'
    }

    // Platform services (media, enrichment, search) only need the token.
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
      agentName,
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

    // The start is the first mark on the idle clock: it floors stale session
    // timestamps from before the previous sleep. The alarm is armed by
    // trackStart once this start is no longer in flight.
    this.activity.started()

    // Broadcast agent status change globally
    messagePersister.broadcastGlobal({
      type: 'agent_status_changed',
      agentSlug: slug,
      status: info.status,
    })

    return client
  }

  // Record a keep-alive ping (e.g. from an open dashboard) to prevent auto-sleep
  keepAlive(): void {
    this.activity.keepAlive()
    this.idleAlarm.schedule()
  }

  /**
   * A session of this agent was sent to or written to at `at` (epoch ms).
   * The actor's session store reports every such write here, so the idle
   * clock follows the sessions without anyone re-reading their metadata.
   */
  noteSessionActivity(at: number = Date.now()): void {
    this.activity.sessionActivity(at)
    this.idleAlarm.schedule()
  }

  /**
   * When this container was last busy — the latest of its start, the last
   * keep-alive and the last session activity — or undefined when none has
   * been recorded since it was last stopped or dropped.
   */
  lastActivityAt(): number | undefined {
    return this.activity.lastActivityAt()
  }

  /**
   * When this container last stopped being busy, or null while a session is
   * active or awaiting input, or while there is nothing to put to sleep: no
   * mark on the clock, or a container that is not running. What the idle
   * alarm decides on; see `ContainerOps.idleSince`.
   */
  idleSince(): number | null {
    return this.isBusy() ? null : (this.sleepableSince() ?? null)
  }

  /**
   * The clock as the alarm sees it: the last mark while the container is
   * running and neither starting nor stopping, otherwise nothing. A session
   * of a stopped agent is still written to (a message deleted, a transcript
   * appended), and that marks the clock, but it must not arm an alarm that
   * would stop a container that is not there — or, worse, one that a later
   * start is in the middle of bringing up.
   */
  private sleepableSince(): number | undefined {
    if (this.starting || this.stopping || this.getCachedInfo().status !== 'running') return undefined
    return this.activity.lastActivityAt()
  }

  private isBusy(): boolean {
    return (
      messagePersister.hasActiveSessionsForAgent(this.slug) ||
      messagePersister.hasSessionsAwaitingInputForAgent(this.slug)
    )
  }

  /** What the idle alarm runs: stop without ever force-stopping the shared VM. */
  private async sleepIdle(): Promise<void> {
    const timeoutMinutes = getSettings().app?.autoSleepTimeoutMinutes ?? 30
    console.log(`[ContainerRuntime] Agent ${this.slug} idle for >${timeoutMinutes}m, stopping...`)
    await this.stopContainer({
      stopTimeoutMs: 60_000,
      killTimeoutMs: 30_000,
      // Never force-stop the shared VM to reclaim one idle container — it would
      // kill every running agent. If stop+kill time out, leave it running; the
      // alarm retries.
      escalateToForceStop: false,
    })
  }

  /**
   * Forget the client and every cached fact about the container. Does not
   * stop the container.
   */
  dispose(): void {
    this.disposed = true
    this.client = null
    this.cached = null
    this.activity.reset()
    this.idleAlarm.cancel()
    this.healthWarnings = []
    this.stopping = false
    this.starting = null
    this.stale = false
    this.webhookRelayAtStart = null
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

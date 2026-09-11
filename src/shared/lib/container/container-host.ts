/**
 * The container host: what is not per-agent about running containers on this
 * machine. Runtime readiness and image pulls, the status-sync and
 * health-monitor loops, start-all and stop-all, shutdown, and the fallout of a
 * force-stop that kills the shared VM.
 *
 * It owns one `ContainerRuntime` per agent; the agent actor reaches its
 * agent's runtime through `runtime(slug)`. Only the actor package imports
 * this module — everything else asks the actor for its agent and imports
 * `containerHost` from `@shared/lib/agent-actor` for the host-level calls.
 */
import { ContainerRuntime, type RuntimeHost } from './container-runtime'
import {
  checkAllRunnersAvailability,
  checkImageExists,
  pullImage,
  canBuildImage,
  buildImage,
  startRunner,
  refreshRunnerAvailability,
  clearRunnerAvailabilityCache,
  reconcileRunnerState,
  getRunnerDisplayName,
  getContainerClientClass,
  getCliCommand,
  getAvailableDiskSpace,
  MIN_IMAGE_DISK_SPACE_BYTES,
  type ContainerRunner,
} from './client-factory'
import { ensureLimaReady } from './lima-container-client'
import type { ImagePullProgress, RuntimeReadiness } from './types'
import { messagePersister } from './message-persister'
import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import path from 'path'
import { getAgentWorkspaceDir, getAgentsDataDir } from '@shared/lib/config/data-dir'
import { captureException, captureMessage, addErrorBreadcrumb } from '@shared/lib/error-reporting'

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

export class ContainerHost {
  private runtimes: Map<string, ContainerRuntime> = new Map()
  private syncIntervalId: NodeJS.Timeout | null = null
  private isSyncing = false
  private healthCheckIntervalId: NodeJS.Timeout | null = null

  /** Optional callback invoked before a container is stopped (e.g. to close host browser) */
  onBeforeContainerStop: ((agentId: string) => Promise<void>) | null = null

  /** Unified runtime readiness state */
  private _readiness: RuntimeReadiness = process.env.E2E_MOCK === 'true'
    ? { status: 'READY', message: 'Ready (E2E mock)', pullProgress: null }
    : { status: 'CHECKING', message: 'Checking runtime availability...', pullProgress: null }

  /** What runtimes see of the host. */
  private readonly hooks: RuntimeHost = (() => {
    const self = this
    return {
      // A getter, so a hook assigned after the first runtime exists still applies.
      get onBeforeContainerStop() {
        return self.onBeforeContainerStop
      },
      afterForceStop: (slug: string) => self.afterForceStop(slug),
    }
  })()

  /** The runtime for an agent, created on first use. Never does I/O. */
  runtime(slug: string): ContainerRuntime {
    let runtime = this.runtimes.get(slug)
    if (!runtime) {
      runtime = new ContainerRuntime(slug, this.hooks)
      this.runtimes.set(slug, runtime)
    }
    return runtime
  }

  /** The runtime if one exists for this agent. */
  peekRuntime(slug: string): ContainerRuntime | undefined {
    return this.runtimes.get(slug)
  }

  /** Forget an agent's runtime (client and cached state). Does not stop the container. */
  dropRuntime(slug: string): void {
    this.runtimes.get(slug)?.dispose()
    this.runtimes.delete(slug)
  }

  /**
   * Where an agent's workspace lives on this machine. A host capability, not
   * an actor operation: its callers open the folder in the OS file manager
   * and point Chrome's downloads at it, both things only this machine can do.
   * An actor whose files are elsewhere has no such path.
   */
  workspaceHostPath(slug: string): string {
    return getAgentWorkspaceDir(slug)
  }

  /**
   * The agent's directory on this machine, above its workspace. Host-only, for
   * the one thing kept there: the host folders bind-mounted into the container.
   */
  agentHostPath(slug: string): string {
    return path.join(getAgentsDataDir(), slug)
  }

  // Forget every runtime (e.g., when the container runner setting changes).
  // Does NOT stop running containers — call stopAll() first if needed.
  //
  // A runtime whose container is starting is kept: the start records its
  // outcome on the runtime it began on, and dropping that runtime would leave
  // the container it brings up running but unknown to the host, so nothing
  // would count it as running or stop it on quit. Only its client is dropped,
  // so the next one is built for the runner configured now.
  clearRuntimes(): void {
    for (const [slug, runtime] of this.runtimes) {
      if (runtime.isStarting()) {
        runtime.resetClient()
        continue
      }
      runtime.dispose()
      this.runtimes.delete(slug)
    }
  }

  // Check if any agents have running containers (uses cached status)
  hasRunningAgents(): boolean {
    for (const runtime of this.runtimes.values()) {
      if (runtime.getCachedInfo().status === 'running') {
        return true
      }
    }
    return false
  }

  // Get list of running agent slugs (uses cached status)
  getRunningAgentIds(): string[] {
    const running: string[] = []
    for (const [slug, runtime] of this.runtimes.entries()) {
      if (runtime.getCachedInfo().status === 'running') {
        running.push(slug)
      }
    }
    return running
  }

  /**
   * Create runtimes for the given agent slugs and sync their statuses.
   * Call this on app startup with the list of all agent slugs.
   */
  async initializeAgents(agentSlugs: string[]): Promise<void> {
    console.log(`[ContainerHost] Initializing ${agentSlugs.length} agents...`)

    // Register callback so message-persister can request container stops on fatal errors (e.g., OOM)
    messagePersister.setStopContainerCallback((agentSlug) => {
      console.log(`[ContainerHost] Stopping container for ${agentSlug} due to fatal error`)
      this.runtime(agentSlug).stopContainer().catch((err) => {
        console.error(`[ContainerHost] Failed to stop container for ${agentSlug}:`, err)
      })
    })
    messagePersister.setUnexpectedDeathCallback((agentSlug, sessionId) => {
      this.runtime(agentSlug).handleUnexpectedDeath(sessionId ? [sessionId] : undefined)
    })

    // Create clients for all agents (this registers them for sync)
    for (const slug of agentSlugs) {
      this.runtime(slug).getClient()
    }

    // Sync all statuses
    await this.syncAllStatuses()

    console.log(`[ContainerHost] Initialized ${agentSlugs.length} agents`)
  }

  /**
   * Sync every known agent's status with reality.
   * Called on startup and periodically.
   */
  async syncAllStatuses(): Promise<void> {
    if (this.isSyncing) {
      console.log('[ContainerHost] Sync already in progress, skipping')
      return
    }

    this.isSyncing = true
    console.log('[ContainerHost] Syncing container statuses with the runtime...')

    try {
      const runtimes = Array.from(this.runtimes.values()).filter((runtime) => runtime.hasClient())

      for (const runtime of runtimes) {
        // Skip agents currently being stopped
        if (runtime.isStopping()) continue

        try {
          await runtime.syncAgentStatus()
        } catch (error) {
          console.error(`[ContainerHost] Failed to sync status for ${runtime.slug}:`, error)
          // Mark as stopped on error
          runtime.markAsStopped()
        }
      }

      console.log(`[ContainerHost] Synced ${runtimes.length} container statuses`)
    } finally {
      this.isSyncing = false
    }
  }

  /**
   * Start the periodic status sync.
   * Note: Does not do an initial sync - call initializeAgents() first for that.
   */
  startStatusSync(): void {
    if (this.syncIntervalId) {
      return // Already running
    }

    console.log(`[ContainerHost] Starting status sync (interval: ${STATUS_SYNC_INTERVAL_MS / 1000}s)`)

    // Set up periodic sync (initial sync is done by initializeAgents)
    this.syncIntervalId = setInterval(() => {
      this.syncAllStatuses().catch((error) => {
        console.error('[ContainerHost] Periodic sync failed:', error)
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
      console.log('[ContainerHost] Stopped status sync')
    }
  }

  /**
   * Start periodic health monitoring for running containers.
   */
  startHealthMonitor(): void {
    if (this.healthCheckIntervalId) {
      return // Already running
    }

    console.log(`[ContainerHost] Starting health monitor (interval: ${HEALTH_CHECK_INTERVAL_MS / 1000}s)`)

    this.healthCheckIntervalId = setInterval(() => {
      this.runHealthChecks().catch((error) => {
        console.error('[ContainerHost] Health check failed:', error)
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
      console.log('[ContainerHost] Stopped health monitor')
    }
  }

  /**
   * Run health checks on all running containers.
   */
  private async runHealthChecks(): Promise<void> {
    const runningIds = this.getRunningAgentIds()
    if (runningIds.length === 0) return

    for (const slug of runningIds) {
      try {
        await this.runtime(slug).runHealthCheck()
      } catch (error) {
        console.error(`[ContainerHost] Health check failed for ${slug}:`, error)
      }
    }
  }

  // Stop all containers (with per-container timeout to prevent blocking shutdown)
  async stopAll(): Promise<void> {
    // Only stop containers that are actually running (based on cached status)
    // to avoid spawning unnecessary CLI processes during shutdown
    const runningIds = this.getRunningAgentIds()
    if (runningIds.length > 0) {
      // Timeout must accommodate the full escalation chain:
      // nerdctl stop (10s) + nerdctl kill (5s) + forceStop (10s) = 25s max
      const STOP_TIMEOUT_MS = 30000
      const stopPromises = runningIds.map(async (slug) => {
        try {
          await Promise.race([
            this.runtime(slug).stopContainer(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Container stop timed out')), STOP_TIMEOUT_MS)
            ),
          ])
        } catch (error) {
          console.error(`Failed to stop container for agent ${slug}:`, error)
        }
      })
      await Promise.all(stopPromises)
    }
    this.clearRuntimes()
  }

  // Synchronous stop - used for exit handlers where async isn't available
  stopAllSync(): void {
    this.stopStatusSync() // Stop the sync interval
    this.stopHealthMonitor() // Stop the health monitor
    for (const runtime of this.runtimes.values()) {
      runtime.stopSync()
    }
    this.clearRuntimes()
  }

  /**
   * A force-stop killed the shared runtime VM (e.g., Lima QEMU process):
   * 1. Mark ALL other running containers as stopped — they died with the VM
   * 2. Clear stale runner availability cache so ensureImageReady sees the dead VM
   * 3. Re-check runtime readiness so the VM restarts in the background
   */
  private afterForceStop(slug: string): void {
    for (const otherId of this.getRunningAgentIds()) {
      if (otherId === slug) continue
      this.runtime(otherId).markAsStopped()
      messagePersister.markAllSessionsInactiveForAgent(otherId, { settleRecovering: true })
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
      console.error('[ContainerHost] Failed to re-check readiness after force stop:', err)
    })
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

  /**
   * Clear a CHECKING banner after a failed start/install and broadcast.
   * Skips if an image pull is in progress (same guard as resetReadiness).
   */
  markRuntimeUnavailable(message: string): void {
    if (this._readiness.status === 'PULLING_IMAGE') {
      return
    }
    this.setReadiness({
      status: 'RUNTIME_UNAVAILABLE',
      message,
      pullProgress: null,
    })
  }

  /**
   * Broadcast start/install progress while status stays CHECKING.
   * Reuses pullProgress so existing readiness UI can show phase + optional %.
   * Skips no-op duplicates and never overrides an in-flight image pull.
   */
  updateStartProgress(progress: ImagePullProgress): void {
    if (this._readiness.status === 'PULLING_IMAGE') {
      return
    }
    const prev = this._readiness.pullProgress
    if (
      this._readiness.status === 'CHECKING' &&
      prev?.status === progress.status &&
      prev?.percent === progress.percent
    ) {
      return
    }
    this.setReadiness({
      status: 'CHECKING',
      message: progress.status,
      pullProgress: progress,
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

    let allAvailability = await checkAllRunnersAvailability()
    let runnerStatus = allAvailability.find((r) => r.runner === configuredRunner)

    // If the runner is already running, check for stale runtime state (e.g. old Lima VM).
    // This is the only path that catches a stale-but-running VM, since startRunner()
    // (which normally handles version checks) is skipped when the VM is already up.
    if (runnerStatus?.running) {
      try {
        const rebuilt = await reconcileRunnerState(configuredRunner)
        if (rebuilt) {
          clearRunnerAvailabilityCache()
          allAvailability = await checkAllRunnersAvailability()
          runnerStatus = allAvailability.find((r) => r.runner === configuredRunner)
        }
      } catch (error: any) {
        // reconcile → ensureLimaReady can throw — e.g. a wedged Lima VM surfaces a
        // recoverable error instead of a destructive rebuild. Don't let it escape
        // ensureImageReady (whose callers only .catch+log), which would leave the
        // readiness spinner stuck forever. Surface it as unavailable.
        captureException(error, {
          tags: { component: 'runtime', operation: 'reconcile' },
          extra: { runner: configuredRunner },
        })
        this.setReadiness({
          status: 'RUNTIME_UNAVAILABLE',
          message: error?.message || `Failed to reconcile ${getRunnerDisplayName(configuredRunner)} runtime.`,
          pullProgress: null,
        })
        return
      }
    }

    if (!runnerStatus?.available) {
      // Auto-start runtimes that support it (Apple Container, Lima, WSL2)
      // TODO the "isAutoStartable" property should live in runtime implementation, not here!
      if ((configuredRunner === 'apple-container' || configuredRunner === 'lima' || configuredRunner === 'wsl2') && runnerStatus?.installed && !runnerStatus?.running) {
        this.setReadiness({
          status: 'CHECKING',
          message: `Starting ${getRunnerDisplayName(configuredRunner)} runtime...`,
          pullProgress: null,
        })

        const startResult = await startRunner(configuredRunner)
        if (startResult.success) {
          addErrorBreadcrumb({ category: 'runtime', message: `${configuredRunner} start initiated, polling for availability` })
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
            const timeoutErr = new Error(`${getRunnerDisplayName(configuredRunner)} runtime failed to start within ${maxPollSeconds}s`)
            captureException(timeoutErr, {
              tags: { component: 'runtime', operation: 'start-timeout' },
              extra: { runner: configuredRunner, pollSeconds: maxPollSeconds },
            })
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
          // Serialized fresh-read + atomic write; re-bind the local
          // snapshot to the persisted result so later reads see fresh state.
          settings = mutateSettings((s) => {
            s.container.containerRunner = configuredRunner
          })
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

    if (!getContainerClientClass(effectiveRunner).requiresLocalImage) {
      this.setReadiness({
        status: 'READY',
        message: `Ready (${getRunnerDisplayName(effectiveRunner)})`,
        pullProgress: null,
      })
      return
    }

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

    // Step 3: Pre-flight disk space check
    try {
      const availableBytes = await getAvailableDiskSpace()
      if (availableBytes < MIN_IMAGE_DISK_SPACE_BYTES) {
        const availableGB = (availableBytes / (1024 * 1024 * 1024)).toFixed(1)
        const requiredGB = (MIN_IMAGE_DISK_SPACE_BYTES / (1024 * 1024 * 1024)).toFixed(0)
        captureMessage('Insufficient disk space for image pull', {
          level: 'info',
          tags: { component: 'runtime', operation: 'disk-space-check' },
          extra: { availableGB: parseFloat(availableGB), requiredGB: parseInt(requiredGB), runner: effectiveRunner },
        })
        this.setReadiness({
          status: 'ERROR',
          message: `Insufficient disk space: ${availableGB} GB available, at least ${requiredGB} GB required to download the agent image. Free up disk space and try again.`,
          pullProgress: null,
        })
        return
      }
    } catch (err) {
      console.warn('[ContainerHost] Disk space check failed, proceeding anyway:', err)
    }

    // Step 4: Build or pull the image
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

    const MAX_PULL_RETRIES = 2
    const RETRY_DELAY_MS = 3000

    const isTransientSshError = (error: unknown): boolean => {
      const msg = error instanceof Error ? error.message : String(error)
      return msg.includes('exit code 255') || msg.includes('kex_exchange_identification') || msg.includes('Connection reset by peer')
    }

    // Pulls killed by the stall watchdog (pullImage in client-factory) are
    // retryable: the registry content store keeps completed layers, so a
    // retry resumes roughly where the wedged download stopped.
    const isRetryablePullError = (error: unknown): boolean => {
      const msg = error instanceof Error ? error.message : String(error)
      return isTransientSshError(error) || msg.includes('Image pull stalled')
    }

    const doImageAction = (onProgress: (progress: ImagePullProgress) => void) => {
      const imageAction = shouldBuild ? buildImage : pullImage
      return imageAction(effectiveRunner, image, onProgress)
    }

    const progressCallback = (progress: ImagePullProgress) => {
      const now = Date.now()
      if (now - lastBroadcastTime >= THROTTLE_MS) {
        this.setReadiness({
          status: 'PULLING_IMAGE',
          message: `${actionLabel} image ${image}...`,
          pullProgress: progress,
        })
        lastBroadcastTime = now
      }
    }

    for (let attempt = 0; attempt <= MAX_PULL_RETRIES; attempt++) {
      try {
        await doImageAction(progressCallback)

        this.setReadiness({
          status: 'READY',
          message: 'Ready',
          pullProgress: null,
        })

        // Clean up old images after a successful pull (fire-and-forget)
        const lastColon = image.lastIndexOf(':')
        if (lastColon > 0 && !shouldBuild) {
          const registry = image.substring(0, lastColon)
          const currentTag = image.substring(lastColon + 1)
          const ClientClass = getContainerClientClass(effectiveRunner)
          ClientClass.removeOldImages(getCliCommand(effectiveRunner), registry, currentTag).catch((error: unknown) => {
            console.warn('[ContainerHost] Image cleanup failed:', error)
          })
        }
        return
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)

        // Only retry transient errors for pull operations (not builds)
        if (!shouldBuild && attempt < MAX_PULL_RETRIES && isRetryablePullError(error)) {
          console.warn(`[ContainerHost] Image pull failed (attempt ${attempt + 1}/${MAX_PULL_RETRIES + 1}), retrying in ${RETRY_DELAY_MS}ms:`, errMsg)
          addErrorBreadcrumb({ category: 'container', message: 'Image pull transient failure, will retry', data: { attempt, errMsg, runner: effectiveRunner } })

          // For Lima runner, attempt VM recovery before retrying
          if (effectiveRunner === 'lima') {
            try {
              await ensureLimaReady()
            } catch (limaErr) {
              console.warn('[ContainerHost] Lima recovery attempt failed:', limaErr)
            }
          }

          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
          lastBroadcastTime = 0

          this.setReadiness({
            status: 'PULLING_IMAGE',
            message: `${actionLabel} image ${image} (retry ${attempt + 1})...`,
            pullProgress: { status: 'Retrying...', percent: null, completedLayers: 0, totalLayers: 0 },
          })
          continue
        }

        // Non-retryable or exhausted retries. pullImage/buildImage capture
        // their own failures at the throw site (flagged sentryCaptured) —
        // don't emit a second event for the same error.
        console.error(`[ContainerHost] Failed to ${actionLabel.toLowerCase()} image ${image}:`, errMsg)
        if (!(error as { sentryCaptured?: boolean })?.sentryCaptured) captureException(error, {
          tags: { component: 'runtime', operation: shouldBuild ? 'image-build' : 'image-pull' },
          extra: { image, runner: effectiveRunner, attempt },
        })
        this.setReadiness({
          status: 'ERROR',
          message: `Failed to ${actionLabel.toLowerCase()} image: ${errMsg}`,
          pullProgress: null,
        })
        return
      }
    }
  }
}

// Export singleton instance
// Use globalThis to persist across hot reloads in development
const globalForHost = globalThis as unknown as {
  containerHost: ContainerHost | undefined
}

const host: ContainerHost = globalForHost.containerHost ?? new ContainerHost()
export const containerHost = host

if (process.env.NODE_ENV !== 'production') {
  globalForHost.containerHost = containerHost
}

// Note: Graceful shutdown handlers are registered in the application entry point
// (src/main/index.ts for Electron, src/web/server.ts for web)
// This avoids side effects at module import time and allows proper cleanup coordination

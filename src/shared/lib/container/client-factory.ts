import type { ContainerClient, ContainerConfig, ImagePullProgress } from './types'
import { captureException, addErrorBreadcrumb } from '@shared/lib/error-reporting'
import { DockerContainerClient } from './docker-container-client'
import { PodmanContainerClient } from './podman-container-client'
import { AppleContainerClient } from './apple-container-client'
import { LimaContainerClient, getNerdctlWrapperPath, ensureLimaReady, stopLimaVm } from './lima-container-client'
import { WSL2ContainerClient, getWSL2NerdctlWrapperPath, ensureWSL2Ready, stopWSL2Distro, killWSL2PullProcesses } from './wsl2-container-client'
import { PlatformK8sRuntimeClient } from './platform-k8s-runtime'
import { LambdaMicroVmRuntimeClient } from './lambda-microvm-runtime'
import { RunnerSetupError, type RunnerSetupRemediation } from './wsl2-setup-errors'
import { MockContainerClient } from './mock-container-client'
import { getSettings } from '@shared/lib/config/settings'
import { BaseContainerClient, execWithPath, spawnWithPath, AGENT_CONTAINER_PATH } from './base-container-client'
import { platform, homedir } from 'os'
import * as fs from 'fs'
import { statfs } from 'fs/promises'

export type ContainerRunner = 'docker' | 'podman' | 'apple-container' | 'lima' | 'wsl2' | 'kubernetes' | 'lambda-microvm'

/**
 * How long a pull may go without any CLI output before the stall watchdog
 * kills it (only on runners that opt in via pullStallTimeoutMs). Observed
 * failure mode: a half-dead HTTPS connection to the registry CDN that stops
 * delivering bytes but never times out, freezing the pull forever mid-layer.
 */
export const PULL_STALL_TIMEOUT_MS = 120_000

/**
 * Hard cap on killStalledPull() cleanup. An unresponsive runtime (e.g. a hung
 * wsl.exe) must not wedge the pull promise — and with it the retry loop —
 * forever; the watchdog settles the pull once this expires.
 */
export const KILL_STALLED_PULL_TIMEOUT_MS = 10_000

export interface RunnerAvailability {
  runner: ContainerRunner
  /** Whether the CLI is installed and found in PATH */
  installed: boolean
  /** Whether the daemon/machine is running and usable */
  running: boolean
  /** Overall availability (installed AND running) */
  available: boolean
  /** If installed but not running, can we attempt to start it? */
  canStart: boolean
  /** Whether settings.container.agentImage is honored by this runner. */
  supportsCustomAgentImage: boolean
}

export interface StartRunnerResult {
  success: boolean
  message: string
  /** Structured remediation when a runtime failed to start with a known, user-resolvable cause. */
  setupError?: RunnerSetupRemediation
}

/**
 * Registry of all container runners with their client classes.
 * Order determines preference (first eligible runner is the default).
 */
const ALL_RUNNERS: {
  name: ContainerRunner
  cliCommand: string | (() => string)
  isEligible: () => boolean
  isAvailable: () => Promise<boolean>
  /** Optional hook to reconcile stale runtime state. Returns true if runtime was rebuilt. */
  reconcileRuntimeState?: () => Promise<boolean>
  isRunning: () => Promise<boolean>
  /** Optional cleanup when the app is shutting down (e.g., stop a VM). */
  shutdownRuntime?: () => Promise<void>
  /**
   * For CLIs that stream continuous progress output (nerdctl): max output
   * silence before a pull is declared stalled, killed, and left to the caller
   * to retry. Leave unset for CLIs that are legitimately quiet for minutes
   * mid-layer (docker, podman print nothing between layer status changes).
   */
  pullStallTimeoutMs?: number
  /**
   * Kill pull processes that outlive the host-side CLI process (e.g. nerdctl
   * inside the WSL2 distro survives its wsl.exe parent and keeps holding
   * containerd's ingest lock, wedging every later pull of that image).
   * Invoked by the stall watchdog before killing the local process.
   */
  killStalledPull?: () => Promise<void>
}[] = [
  { name: 'apple-container', cliCommand: 'container', isEligible: () => AppleContainerClient.isEligible(), isAvailable: () => AppleContainerClient.isAvailable(), isRunning: () => AppleContainerClient.isRunning(), shutdownRuntime: () => execWithPath('container system stop').then(() => {}) },
  { name: 'docker', cliCommand: 'docker', isEligible: () => DockerContainerClient.isEligible(), isAvailable: () => DockerContainerClient.isAvailable(), isRunning: () => DockerContainerClient.isRunning() },
  { name: 'podman', cliCommand: 'podman', isEligible: () => PodmanContainerClient.isEligible(), isAvailable: () => PodmanContainerClient.isAvailable(), isRunning: () => PodmanContainerClient.isRunning() },
  { name: 'lima', cliCommand: () => getNerdctlWrapperPath(), isEligible: () => LimaContainerClient.isEligible(), isAvailable: () => LimaContainerClient.isAvailable(), reconcileRuntimeState: () => LimaContainerClient.reconcileRuntimeState(), isRunning: () => LimaContainerClient.isRunning(), shutdownRuntime: () => stopLimaVm() },
  { name: 'wsl2', cliCommand: () => getWSL2NerdctlWrapperPath(), isEligible: () => WSL2ContainerClient.isEligible(), isAvailable: () => WSL2ContainerClient.isAvailable(), isRunning: () => WSL2ContainerClient.isRunning(), shutdownRuntime: () => stopWSL2Distro(), pullStallTimeoutMs: PULL_STALL_TIMEOUT_MS, killStalledPull: () => killWSL2PullProcesses() },
  { name: 'kubernetes', cliCommand: 'kubernetes', isEligible: () => PlatformK8sRuntimeClient.isEligible(), isAvailable: () => PlatformK8sRuntimeClient.isAvailable(), isRunning: () => PlatformK8sRuntimeClient.isRunning() },
  { name: 'lambda-microvm', cliCommand: 'lambda-microvm', isEligible: () => LambdaMicroVmRuntimeClient.isEligible(), isAvailable: () => LambdaMicroVmRuntimeClient.isAvailable(), isRunning: () => LambdaMicroVmRuntimeClient.isRunning() },
]

/**
 * Supported container runners on this platform, filtered by eligibility.
 * Order reflects preference (apple-container first on macOS 26+, then docker, then podman).
 */
export const SUPPORTED_RUNNERS: ContainerRunner[] = ALL_RUNNERS
  .filter((r) => r.isEligible())
  .map((r) => r.name)

/**
 * User-facing display name for a runner.
 */
const RUNNER_DISPLAY_NAMES: Record<ContainerRunner, string> = {
  'apple-container': 'macOS Container',
  docker: 'Docker',
  podman: 'Podman',
  lima: 'Built-in Runtime',
  wsl2: 'Built-in Runtime',
  kubernetes: 'Kubernetes',
  'lambda-microvm': 'AWS Lambda MicroVM',
}

export function getRunnerDisplayName(runner: ContainerRunner): string {
  return RUNNER_DISPLAY_NAMES[runner] || runner
}

/**
 * Get the actual CLI command for a runner name.
 * E.g., 'apple-container' -> 'container', 'docker' -> 'docker'
 */
export function getCliCommand(runner: ContainerRunner): string {
  const entry = ALL_RUNNERS.find((r) => r.name === runner)
  if (!entry) return runner
  const cmd = typeof entry.cliCommand === 'function' ? entry.cliCommand() : entry.cliCommand
  // Quote paths that contain spaces (e.g. Windows users with spaces in their username).
  // Both execWithPath (shell string) and spawnWithPath (shell: true) need quoting.
  if (cmd.includes(' ') && !cmd.startsWith('"')) return `"${cmd}"`
  return cmd
}

/** Cache for runner availability to avoid spawning docker commands repeatedly */
let cachedRunnerAvailability: RunnerAvailability[] | null = null
let runnerAvailabilityCachedAt: number = 0
/** How long to cache runner availability (default: 60 seconds) */
const RUNNER_AVAILABILITY_CACHE_TTL_MS = parseInt(
  process.env.RUNNER_AVAILABILITY_CACHE_TTL_SECONDS || '60',
  10
) * 1000

/**
 * Check if we can attempt to start this runner.
 * Only possible on macOS for Docker Desktop and Podman machine.
 */
function canAttemptStart(runner: ContainerRunner): boolean {
  if (runner === 'apple-container' || runner === 'lima') {
    // Apple Container and Lima are always startable on macOS (where they're eligible)
    return true
  }
  if (runner === 'wsl2') {
    // WSL2 is always startable on Windows (where it's eligible)
    return true
  }
  const os = platform()
  if (os === 'darwin') {
    // On macOS, we can start Docker Desktop or Podman machine
    return true
  }
  if (os === 'win32' && runner === 'docker') {
    // On Windows, we can start Docker Desktop
    return true
  }
  // On Linux, Docker typically requires sudo to start the daemon
  // Podman on Linux is daemonless and should just work if installed
  return false
}

/**
 * Attempt to start a container runtime.
 * Returns true if start was attempted (not necessarily successful).
 */
// TODO: disgusting piece of code. The whole idea of having the container client classes is that they should encapsulate all runtime-specific logic, including starting the runtime if needed. We should move this logic into static methods on each client class, e.g., DockerContainerClient.startRuntime(), PodmanContainerClient.startRuntime(), etc. Then this function can just delegate to the appropriate class without needing to know about platform-specific details here. Refactor this in the future to clean up the code and adhere to better separation of concerns.
export async function startRunner(runner: ContainerRunner): Promise<StartRunnerResult> {
  const os = platform()

  if (runner === 'apple-container') {
    try {
      await execWithPath('container system start')
      return { success: true, message: 'Apple Container runtime is starting...' }
    } catch (error: any) {
      if (error.message?.includes('already running')) {
        return { success: true, message: 'Apple Container runtime is already running.' }
      }
      captureException(error, {
        tags: { component: 'runtime', operation: 'start-apple-container' },
        extra: { platform: os },
      })
      return { success: false, message: `Failed to start Apple Container runtime: ${error.message}` }
    }
  }

  if (runner === 'lima') {
    try {
      await ensureLimaReady()
      return { success: true, message: 'Built-in runtime is running.' }
    } catch (error: any) {
      return { success: false, message: `Failed to start built-in runtime: ${error.message}` }
    }
  }

  if (runner === 'wsl2') {
    try {
      await ensureWSL2Ready()
      return { success: true, message: 'Built-in runtime is running.' }
    } catch (error: any) {
      if (error instanceof RunnerSetupError) {
        return {
          success: false,
          message: error.title,
          setupError: error.toPayload(),
        }
      }
      return { success: false, message: `Failed to start built-in runtime: ${error.message}` }
    }
  }

  if (os === 'darwin') {
    if (runner === 'docker') {
      try {
        // Start Docker Desktop on macOS
        await execWithPath('open -a Docker')
        return { success: true, message: 'Docker Desktop is starting...' }
      } catch (error) {
        return { success: false, message: 'Failed to start Docker Desktop. Is it installed?' }
      }
    } else if (runner === 'podman') {
      try {
        // Check if a podman machine exists
        const { stdout } = await execWithPath('podman machine list --format "{{.Name}}"')
        const machines = stdout.trim().split('\n').filter(Boolean)

        if (machines.length === 0) {
          // No machine exists, need to initialize one first
          return {
            success: false,
            message: 'No Podman machine found. Run "podman machine init" first.',
          }
        }

        // Start the first machine (usually 'podman-machine-default')
        await execWithPath(`podman machine start ${machines[0]}`)
        return { success: true, message: `Podman machine "${machines[0]}" is starting...` }
      } catch (error: any) {
        // Machine might already be running
        if (error.message?.includes('already running')) {
          return { success: true, message: 'Podman machine is already running.' }
        }
        return { success: false, message: `Failed to start Podman machine: ${error.message}` }
      }
    }
  } else if (os === 'win32') {
    if (runner === 'docker') {
      try {
        // Start Docker Desktop on Windows
        const dockerDesktopPath = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'
        if (fs.existsSync(dockerDesktopPath)) {
          const { spawn } = await import('child_process')
          spawn(dockerDesktopPath, [], { detached: true, stdio: 'ignore' }).unref()
          return { success: true, message: 'Docker Desktop is starting...' }
        }
        return { success: false, message: 'Docker Desktop not found. Is it installed?' }
      } catch (error) {
        return { success: false, message: 'Failed to start Docker Desktop. Is it installed?' }
      }
    }
  } else if (os === 'linux') {
    if (runner === 'docker') {
      return {
        success: false,
        message: 'Docker daemon needs to be started with "sudo systemctl start docker".',
      }
    } else if (runner === 'podman') {
      // Podman on Linux is daemonless, should work if installed
      return {
        success: false,
        message: 'Podman on Linux is daemonless. If installed, it should work automatically.',
      }
    }
  }

  return { success: false, message: `Cannot auto-start ${runner} on this platform.` }
}

/**
 * Restart a container runtime. Stops the runtime, then starts it again.
 * Used when runtime-specific settings change (e.g., Lima VM memory).
 */
export async function restartRunner(runner: ContainerRunner): Promise<StartRunnerResult> {
  // Clear availability cache immediately so any concurrent polls reflect the stopped state
  clearRunnerAvailabilityCache()

  // Stop the runtime if it has a shutdown handler (Lima VM, Apple Container, WSL2)
  // For docker/podman, we don't stop the daemon — just restart by starting
  const entry = ALL_RUNNERS.find((r) => r.name === runner)
  if (entry?.shutdownRuntime) {
    try {
      await entry.shutdownRuntime()
    } catch {
      // Runtime might not be running, that's fine
    }
  }

  // Start it back up (ensureLimaReady will recreate VM if config changed)
  return startRunner(runner)
}

/**
 * Check detailed availability of a specific runner.
 */
async function checkRunnerDetailedAvailability(runner: ContainerRunner): Promise<RunnerAvailability> {
  const supportsCustomAgentImage = getContainerClientClass(runner).supportsCustomAgentImage
  const entry = ALL_RUNNERS.find((r) => r.name === runner)
  if (!entry) {
    return { runner, installed: false, running: false, available: false, canStart: false, supportsCustomAgentImage }
  }

  const installed = await entry.isAvailable()

  if (!installed) {
    return {
      runner,
      installed: false,
      running: false,
      available: false,
      canStart: false,
      supportsCustomAgentImage,
    }
  }

  const running = await entry.isRunning()

  return {
    runner,
    installed: true,
    running,
    available: running,
    canStart: !running && canAttemptStart(runner),
    supportsCustomAgentImage,
  }
}

/**
 * Check availability of all supported runners with detailed status.
 * Results are cached to avoid spawning docker commands on every call.
 */
export async function checkAllRunnersAvailability(): Promise<RunnerAvailability[]> {
  // In E2E mock mode, skip real runtime checks
  if (process.env.E2E_MOCK === 'true') {
    return [{ runner: 'docker', installed: true, running: true, available: true, canStart: false, supportsCustomAgentImage: true }]
  }

  const now = Date.now()

  // Return cached result if still valid
  if (cachedRunnerAvailability && (now - runnerAvailabilityCachedAt) < RUNNER_AVAILABILITY_CACHE_TTL_MS) {
    return cachedRunnerAvailability
  }

  // Fetch fresh data
  const results = await Promise.all(
    SUPPORTED_RUNNERS.map((runner) => checkRunnerDetailedAvailability(runner))
  )

  // Cache the results
  cachedRunnerAvailability = results
  runnerAvailabilityCachedAt = now

  return results
}

/**
 * Force refresh of runner availability cache.
 * Call this after starting a runner or when user requests refresh.
 */
export async function refreshRunnerAvailability(): Promise<RunnerAvailability[]> {
  cachedRunnerAvailability = null
  runnerAvailabilityCachedAt = 0
  return checkAllRunnersAvailability()
}

/**
 * Clear runner availability cache.
 */
export function clearRunnerAvailabilityCache(): void {
  cachedRunnerAvailability = null
  runnerAvailabilityCachedAt = 0
}

/**
 * Reconcile stale runtime state for a specific runner.
 * Returns true if the runtime was rebuilt (caller should refresh availability).
 */
export async function reconcileRunnerState(runner: ContainerRunner): Promise<boolean> {
  const entry = ALL_RUNNERS.find((r) => r.name === runner)
  if (!entry?.reconcileRuntimeState) return false
  return entry.reconcileRuntimeState()
}

/** Minimum free disk space (in bytes) required before pulling/building an image: 5 GB */
export const MIN_IMAGE_DISK_SPACE_BYTES = 5 * 1024 * 1024 * 1024

/** Free bytes on the volume the agent image lands on (host home dir). */
export async function getAvailableDiskSpace(): Promise<number> {
  const stats = await statfs(homedir())
  return stats.bavail * stats.bsize
}

/**
 * Check if a container image exists locally.
 */
export async function checkImageExists(runner: ContainerRunner, image: string): Promise<boolean> {
  try {
    const cli = getCliCommand(runner)
    await execWithPath(`${cli} image inspect ${image}`)
    return true
  } catch {
    return false
  }
}

/**
 * Pull a container image, reporting layer-based progress.
 *
 * Docker/Podman non-TTY output:
 *   abc123: Pulling fs layer
 *   abc123: Pull complete
 *   def456: Already exists
 *
 * nerdctl non-TTY (plain) output:
 *   manifest-sha256:abc123: done
 *   config-sha256:def456: done
 *   layer-sha256:ghi789: downloading ...
 *   layer-sha256:ghi789: done
 *
 * We track unique layer/item IDs and completed ones to compute progress.
 */
/**
 * In-flight pulls keyed by runner:image. Startup's ensureImageReady() and a
 * session start's ensureImageExists() can both decide to pull the same image
 * concurrently; sharing one pull avoids a duplicate multi-GB download and the
 * loser failing a start the winner was about to satisfy.
 */
const inflightPulls = new Map<string, Promise<void>>()

export function pullImage(
  runner: ContainerRunner,
  image: string,
  onProgress?: (progress: ImagePullProgress) => void
): Promise<void> {
  const key = `${runner}:${image}`
  const existing = inflightPulls.get(key)
  if (existing) {
    addErrorBreadcrumb({ category: 'container', message: 'Awaiting already in-flight pull of the same image', data: { image, runner } })
    return existing
  }
  const pull = doPullImage(runner, image, onProgress).finally(() => inflightPulls.delete(key))
  inflightPulls.set(key, pull)
  return pull
}

function doPullImage(
  runner: ContainerRunner,
  image: string,
  onProgress?: (progress: ImagePullProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cli = getCliCommand(runner)
    // Apple's container CLI uses `container image pull`, not `container pull`
    const args = runner === 'apple-container'
      ? ['image', 'pull', image]
      : ['pull', image]
    const proc = spawnWithPath(cli, args)

    const allLayers = new Set<string>()
    const completedLayers = new Set<string>()
    const stderrChunks: string[] = []
    // Docker: "abc123def: Pull complete" or "abc123def: Already exists"
    const dockerLayerPattern = /^([a-f0-9]+):\s+(.+)$/i
    const dockerCompletedStatuses = ['pull complete', 'already exists']
    // nerdctl: "layer-sha256:abc123:    done    |...|" (with ANSI codes and progress bars)
    // After stripping ANSI codes: capture the type-sha256:hash identifier and the status word
    const nerdctlItemPattern = /^((?:layer|manifest|config|index)-sha256:[a-f0-9]+):\s+(\w+)/i
    const nerdctlCompletedStatuses = ['done', 'exists']
    // Strip ANSI escape sequences (colors, cursor movement, etc.)
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

    // Stall watchdog. nerdctl redraws its progress bars continuously, so
    // prolonged output silence means the download is wedged (observed in the
    // field: a half-dead registry-CDN connection that stops delivering bytes
    // but never times out, freezing the pull mid-layer forever). Only runners
    // that opt in via pullStallTimeoutMs get the watchdog — docker/podman
    // print nothing between layer status changes, so silence is normal there.
    const runnerEntry = ALL_RUNNERS.find((r) => r.name === runner)
    const stallTimeoutMs = runnerEntry?.pullStallTimeoutMs
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    let stallError: Error | undefined
    const onStall = async () => {
      // sentryCaptured: canonical event for the failure, like the exit-code
      // path below — callers up the stack must not re-capture it.
      stallError = Object.assign(
        new Error(`Image pull stalled: no progress output for ${Math.round(stallTimeoutMs! / 1000)}s while pulling ${image}`),
        { sentryCaptured: true }
      )
      captureException(stallError, {
        tags: { component: 'container', operation: 'image-pull-stall' },
        extra: {
          image,
          runner,
          stallTimeoutMs,
          completedLayers: completedLayers.size,
          totalLayers: allLayers.size,
        },
      })
      // Kill the runner-side pull first: for wsl2 the real nerdctl runs inside
      // the distro and survives proc.kill() of the host-side wrapper, keeping
      // containerd's ingest lock held — a retry would wedge behind it. The
      // cleanup itself is time-capped: if the runtime is unresponsive, the
      // pull must still settle so the retry loop isn't stuck forever.
      let killTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.resolve(runnerEntry?.killStalledPull?.()),
          new Promise<never>((_, rejectTimeout) => {
            killTimer = setTimeout(
              () => rejectTimeout(new Error(`killStalledPull timed out after ${KILL_STALLED_PULL_TIMEOUT_MS}ms`)),
              KILL_STALLED_PULL_TIMEOUT_MS
            )
          }),
        ])
      } catch (err) {
        console.warn(`[pullImage] killStalledPull failed for ${runner}:`, err)
      } finally {
        clearTimeout(killTimer)
        proc.kill()
        reject(stallError)
      }
    }
    const armStallTimer = () => {
      if (!stallTimeoutMs) return
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => { void onStall() }, stallTimeoutMs)
    }
    armStallTimer()

    const handleData = (data: Buffer) => {
      if (stallError) return
      armStallTimer()
      const text = stripAnsi(data.toString())
      const lines = text.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        // Try nerdctl format first (more specific pattern)
        const nerdctlMatch = trimmed.match(nerdctlItemPattern)
        if (nerdctlMatch) {
          const itemId = nerdctlMatch[1]
          const status = nerdctlMatch[2].toLowerCase()
          allLayers.add(itemId)
          if (nerdctlCompletedStatuses.includes(status)) {
            completedLayers.add(itemId)
          }
        } else {
          // Try Docker format
          const dockerMatch = trimmed.match(dockerLayerPattern)
          if (dockerMatch) {
            const layerId = dockerMatch[1]
            const status = dockerMatch[2].toLowerCase()
            allLayers.add(layerId)
            if (dockerCompletedStatuses.some((s) => status.startsWith(s))) {
              completedLayers.add(layerId)
            }
          }
        }

        if (onProgress) {
          const total = allLayers.size
          const completed = completedLayers.size
          onProgress({
            status: total > 0
              ? `${completed} of ${total} layers`
              : trimmed,
            percent: total > 0 ? Math.round((completed / total) * 100) : null,
            completedLayers: completed,
            totalLayers: total,
          })
        }
      }
    }

    proc.stdout?.on('data', handleData)
    proc.stderr?.on('data', (data: Buffer) => {
      stderrChunks.push(data.toString())
      handleData(data)
    })

    proc.on('close', (code) => {
      clearTimeout(stallTimer)
      if (stallError) {
        // The watchdog already rejected and reported; this exit is just the
        // kill landing.
        return
      }
      if (code === 0) {
        addErrorBreadcrumb({ category: 'container', message: 'Image pull completed', data: { image, runner } })
        resolve()
      } else {
        const stderr = stderrChunks.join('').trim()
        const detail = stderr ? `: ${stderr.slice(-500)}` : ''
        // sentryCaptured: this capture is the canonical event for the failure —
        // callers up the stack (start()'s catch, handleRunError fallthroughs,
        // ensureImageReady) must not re-capture the same error.
        const pullError = Object.assign(new Error(`Image pull failed with exit code ${code}${detail}`), { sentryCaptured: true })
        captureException(pullError, {
          tags: { component: 'container', operation: 'image-pull' },
          extra: {
            image,
            runner,
            exitCode: code,
            stderr: stderr.slice(-2000),
            completedLayers: completedLayers.size,
            totalLayers: allLayers.size,
          },
        })
        reject(pullError)
      }
    })
    proc.on('error', (err) => {
      clearTimeout(stallTimer)
      captureException(err, {
        tags: { component: 'container', operation: 'image-pull-spawn' },
        extra: { image, runner },
      })
      reject(Object.assign(err, { sentryCaptured: true }))
    })
  })
}

/**
 * Check if the local agent-container build context exists (dev mode).
 */
export function canBuildImage(): boolean {
  return fs.existsSync(AGENT_CONTAINER_PATH)
}

/**
 * Build a container image from the local agent-container directory.
 * Used in dev mode where the image isn't available on a registry.
 */
export function buildImage(
  runner: ContainerRunner,
  image: string,
  onProgress?: (progress: ImagePullProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cli = getCliCommand(runner)
    const proc = spawnWithPath(cli, ['build', '-t', image, AGENT_CONTAINER_PATH])

    let stepCount = 0
    const stderrChunks: string[] = []

    const handleData = (data: Buffer) => {
      const text = data.toString()
      const lines = text.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // Count build steps (lines starting with "Step" or "#" for BuildKit)
        if (/^(Step \d|#\d)/.test(trimmed)) {
          stepCount++
        }
        if (onProgress) {
          onProgress({
            status: trimmed.length > 80 ? trimmed.slice(0, 80) + '...' : trimmed,
            percent: null,
            completedLayers: stepCount,
            totalLayers: 0,
          })
        }
      }
    }

    proc.stdout?.on('data', handleData)
    proc.stderr?.on('data', (data: Buffer) => {
      stderrChunks.push(data.toString())
      handleData(data)
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        const stderr = stderrChunks.join('').trim()
        const detail = stderr ? `: ${stderr.slice(-500)}` : ''
        // sentryCaptured: canonical event — see pullImage.
        const buildError = Object.assign(new Error(`Image build failed with exit code ${code}${detail}`), { sentryCaptured: true })
        captureException(buildError, {
          tags: { component: 'container', operation: 'image-build' },
          extra: { image, runner, exitCode: code, stderr: stderr.slice(-2000) },
        })
        reject(buildError)
      }
    })
    proc.on('error', (err) => {
      captureException(err, {
        tags: { component: 'container', operation: 'image-build-spawn' },
        extra: { image, runner },
      })
      reject(Object.assign(err, { sentryCaptured: true }))
    })
  })
}

// A concrete (non-abstract) subclass of BaseContainerClient
type ConcreteContainerClientClass = (new (config: ContainerConfig) => BaseContainerClient) & typeof BaseContainerClient

/**
 * Get the concrete ContainerClient class for a given runner.
 * Useful for calling static methods (e.g. removeOldImages) with proper dispatch.
 */
export function getContainerClientClass(runner: ContainerRunner): ConcreteContainerClientClass {
  switch (runner) {
    case 'apple-container':
      return AppleContainerClient
    case 'docker':
      return DockerContainerClient
    case 'podman':
      return PodmanContainerClient
    case 'lima':
      return LimaContainerClient
    case 'wsl2':
      return WSL2ContainerClient
    case 'kubernetes':
      return PlatformK8sRuntimeClient
    case 'lambda-microvm':
      return LambdaMicroVmRuntimeClient
    default:
      console.warn(`Unknown container runner "${runner}", falling back to docker`)
      return DockerContainerClient
  }
}

/**
 * Creates a ContainerClient based on the configured container runner.
 */
export function createContainerClient(config: ContainerConfig): ContainerClient {
  // In E2E test mode, use mock client
  if (process.env.E2E_MOCK === 'true') {
    console.log('[ContainerClient] E2E_MOCK=true, using MockContainerClient')
    return new MockContainerClient(config)
  }
  console.log('[ContainerClient] Using real container client, E2E_MOCK:', process.env.E2E_MOCK)

  const settings = getSettings()
  const ClientClass = getContainerClientClass(settings.container.containerRunner as ContainerRunner)
  return new ClientClass(config)
}

/**
 * Shut down the currently configured container runtime (e.g., stop Lima VM).
 * No-op for runtimes that don't need shutdown (Docker, Podman).
 * Called during app shutdown from startup.ts.
 */
export async function shutdownActiveRunner(): Promise<void> {
  const settings = getSettings()
  const runner = settings.container.containerRunner as ContainerRunner
  const entry = ALL_RUNNERS.find((r) => r.name === runner)
  if (entry?.shutdownRuntime) {
    await entry.shutdownRuntime()
  }
}

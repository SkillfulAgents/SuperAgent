import type { ContainerClient, ContainerConfig, ImagePullProgress } from './types'
import { DockerContainerClient } from './docker-container-client'
import { PodmanContainerClient } from './podman-container-client'
import { AppleContainerClient } from './apple-container-client'
import { MockContainerClient } from './mock-container-client'
import { getSettings } from '@shared/lib/config/settings'
import { execWithPath, spawnWithPath, AGENT_CONTAINER_PATH } from './base-container-client'
import { platform } from 'os'
import * as fs from 'fs'

export type ContainerRunner = 'docker' | 'podman' | 'apple-container'

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
}

/**
 * Registry of all container runners with their client classes.
 * Order determines preference (first eligible runner is the default).
 */
const ALL_RUNNERS: {
  name: ContainerRunner
  cliCommand: string
  isEligible: () => boolean
  isAvailable: () => Promise<boolean>
  isRunning: () => Promise<boolean>
}[] = [
  { name: 'apple-container', cliCommand: 'container', isEligible: () => AppleContainerClient.isEligible(), isAvailable: () => AppleContainerClient.isAvailable(), isRunning: () => AppleContainerClient.isRunning() },
  { name: 'docker', cliCommand: 'docker', isEligible: () => DockerContainerClient.isEligible(), isAvailable: () => DockerContainerClient.isAvailable(), isRunning: () => DockerContainerClient.isRunning() },
  { name: 'podman', cliCommand: 'podman', isEligible: () => PodmanContainerClient.isEligible(), isAvailable: () => PodmanContainerClient.isAvailable(), isRunning: () => PodmanContainerClient.isRunning() },
]

/**
 * Supported container runners on this platform, filtered by eligibility.
 * Order reflects preference (apple-container first on macOS 26+, then docker, then podman).
 */
export const SUPPORTED_RUNNERS: ContainerRunner[] = ALL_RUNNERS
  .filter((r) => r.isEligible())
  .map((r) => r.name)

/**
 * Get the actual CLI command for a runner name.
 * E.g., 'apple-container' -> 'container', 'docker' -> 'docker'
 */
function getCliCommand(runner: ContainerRunner): string {
  return ALL_RUNNERS.find((r) => r.name === runner)?.cliCommand ?? runner
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
  if (runner === 'apple-container') {
    // Apple Container is always startable on macOS (where it's eligible)
    return true
  }
  const os = platform()
  if (os === 'darwin') {
    // On macOS, we can start Docker Desktop or Podman machine
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
export async function startRunner(runner: ContainerRunner): Promise<{ success: boolean; message: string }> {
  const os = platform()

  if (runner === 'apple-container') {
    try {
      await execWithPath('container system start')
      return { success: true, message: 'Apple Container runtime is starting...' }
    } catch (error: any) {
      if (error.message?.includes('already running')) {
        return { success: true, message: 'Apple Container runtime is already running.' }
      }
      return { success: false, message: `Failed to start Apple Container runtime: ${error.message}` }
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
 * Check detailed availability of a specific runner.
 */
async function checkRunnerDetailedAvailability(runner: ContainerRunner): Promise<RunnerAvailability> {
  const entry = ALL_RUNNERS.find((r) => r.name === runner)
  if (!entry) {
    return { runner, installed: false, running: false, available: false, canStart: false }
  }

  const installed = await entry.isAvailable()

  if (!installed) {
    return {
      runner,
      installed: false,
      running: false,
      available: false,
      canStart: false,
    }
  }

  const running = await entry.isRunning()

  return {
    runner,
    installed: true,
    running,
    available: running,
    canStart: !running && canAttemptStart(runner),
  }
}

/**
 * Check availability of all supported runners with detailed status.
 * Results are cached to avoid spawning docker commands on every call.
 */
export async function checkAllRunnersAvailability(): Promise<RunnerAvailability[]> {
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
 * In non-TTY (piped) mode, docker/podman pull output lines like:
 *   abc123: Pulling fs layer
 *   abc123: Pull complete
 *   def456: Already exists
 *
 * We track unique layer IDs and completed layers to compute progress.
 */
export function pullImage(
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
    // Match lines like "abc123def: Pull complete" or "abc123def: Already exists"
    const layerIdPattern = /^([a-f0-9]+):\s+(.+)$/i
    const completedStatuses = ['pull complete', 'already exists']

    const handleData = (data: Buffer) => {
      const text = data.toString()
      const lines = text.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        const match = trimmed.match(layerIdPattern)
        if (match) {
          const layerId = match[1]
          const status = match[2].toLowerCase()
          allLayers.add(layerId)
          if (completedStatuses.some((s) => status.startsWith(s))) {
            completedLayers.add(layerId)
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
    proc.stderr?.on('data', handleData)

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Image pull failed with exit code ${code}`))
      }
    })
    proc.on('error', reject)
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
    proc.stderr?.on('data', handleData)

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Image build failed with exit code ${code}`))
      }
    })
    proc.on('error', reject)
  })
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
  const runner = settings.container.containerRunner as ContainerRunner

  switch (runner) {
    case 'apple-container':
      return new AppleContainerClient(config)
    case 'docker':
      return new DockerContainerClient(config)
    case 'podman':
      return new PodmanContainerClient(config)
    default:
      console.warn(`Unknown container runner "${runner}", falling back to docker`)
      return new DockerContainerClient(config)
  }
}

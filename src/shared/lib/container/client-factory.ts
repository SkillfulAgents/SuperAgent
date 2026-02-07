import type { ContainerClient, ContainerConfig, ImagePullProgress } from './types'
import { DockerContainerClient } from './docker-container-client'
import { PodmanContainerClient } from './podman-container-client'
import { MockContainerClient } from './mock-container-client'
import { getSettings } from '@shared/lib/config/settings'
import { execWithPath, spawnWithPath, checkCommandAvailable, AGENT_CONTAINER_PATH } from './base-container-client'
import { platform } from 'os'
import * as fs from 'fs'

export type ContainerRunner = 'docker' | 'podman'

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
 * All supported container runners in order of preference.
 */
export const SUPPORTED_RUNNERS: ContainerRunner[] = ['docker', 'podman']

/** Cache for runner availability to avoid spawning docker commands repeatedly */
let cachedRunnerAvailability: RunnerAvailability[] | null = null
let runnerAvailabilityCachedAt: number = 0
/** How long to cache runner availability (default: 60 seconds) */
const RUNNER_AVAILABILITY_CACHE_TTL_MS = parseInt(
  process.env.RUNNER_AVAILABILITY_CACHE_TTL_SECONDS || '60',
  10
) * 1000

/**
 * Check if a runtime's daemon/machine is running and usable.
 * This is different from just having the CLI installed.
 */
async function checkRuntimeRunning(runner: ContainerRunner): Promise<boolean> {
  try {
    // `docker info` and `podman info` check if the daemon/machine is running
    await execWithPath(`${runner} info`)
    return true
  } catch {
    return false
  }
}

/**
 * Check if we can attempt to start this runner.
 * Only possible on macOS for Docker Desktop and Podman machine.
 */
function canAttemptStart(_runner: ContainerRunner): boolean {
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
  const installed = await checkCommandAvailable(runner)

  if (!installed) {
    return {
      runner,
      installed: false,
      running: false,
      available: false,
      canStart: false,
    }
  }

  const running = await checkRuntimeRunning(runner)

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
    await execWithPath(`${runner} image inspect ${image}`)
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
    const proc = spawnWithPath(runner, ['pull', image])

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
    const proc = spawnWithPath(runner, ['build', '-t', image, AGENT_CONTAINER_PATH])

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
    case 'docker':
      return new DockerContainerClient(config)
    case 'podman':
      return new PodmanContainerClient(config)
    default:
      console.warn(`Unknown container runner "${runner}", falling back to docker`)
      return new DockerContainerClient(config)
  }
}

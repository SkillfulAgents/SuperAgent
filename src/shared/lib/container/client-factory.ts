import type { ContainerClient, ContainerConfig } from './types'
import { DockerContainerClient } from './docker-container-client'
import { PodmanContainerClient } from './podman-container-client'
import { MockContainerClient } from './mock-container-client'
import { getSettings } from '@shared/lib/config/settings'
import { execWithPath, checkCommandAvailable } from './base-container-client'
import { platform } from 'os'

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
 */
export async function checkAllRunnersAvailability(): Promise<RunnerAvailability[]> {
  const results = await Promise.all(
    SUPPORTED_RUNNERS.map((runner) => checkRunnerDetailedAvailability(runner))
  )
  return results
}

/**
 * Simple check if a runner is available (installed and running).
 */
async function checkRunnerAvailability(runner: ContainerRunner): Promise<boolean> {
  const status = await checkRunnerDetailedAvailability(runner)
  return status.available
}

/**
 * Get the first available runner, or null if none are available.
 */
export async function getFirstAvailableRunner(): Promise<ContainerRunner | null> {
  for (const runner of SUPPORTED_RUNNERS) {
    if (await checkRunnerAvailability(runner)) {
      return runner
    }
  }
  return null
}

/**
 * Get the effective runner to use - the configured one if available,
 * otherwise the first available one.
 */
export async function getEffectiveRunner(): Promise<ContainerRunner | null> {
  const settings = getSettings()
  const configuredRunner = settings.container.containerRunner as ContainerRunner

  // Check if configured runner is available
  if (await checkRunnerAvailability(configuredRunner)) {
    return configuredRunner
  }

  // Fall back to first available
  return getFirstAvailableRunner()
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

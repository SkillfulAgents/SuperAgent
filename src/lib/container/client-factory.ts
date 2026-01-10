import type { ContainerClient, ContainerConfig } from './types'
import { DockerContainerClient } from './docker-container-client'
import { PodmanContainerClient } from './podman-container-client'
import { getSettings } from '@/lib/config/settings'

export type ContainerRunner = 'docker' | 'podman'

export interface RunnerAvailability {
  runner: ContainerRunner
  available: boolean
}

/**
 * All supported container runners in order of preference.
 */
export const SUPPORTED_RUNNERS: ContainerRunner[] = ['docker', 'podman']

/**
 * Check availability of a specific runner.
 */
async function checkRunnerAvailability(runner: ContainerRunner): Promise<boolean> {
  switch (runner) {
    case 'docker':
      return DockerContainerClient.isAvailable()
    case 'podman':
      return PodmanContainerClient.isAvailable()
    default:
      return false
  }
}

/**
 * Check availability of all supported runners.
 */
export async function checkAllRunnersAvailability(): Promise<RunnerAvailability[]> {
  const results = await Promise.all(
    SUPPORTED_RUNNERS.map(async (runner) => ({
      runner,
      available: await checkRunnerAvailability(runner),
    }))
  )
  return results
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

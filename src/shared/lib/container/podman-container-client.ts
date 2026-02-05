import { BaseContainerClient, checkCommandAvailable } from './base-container-client'
import type { ContainerConfig } from './types'

/**
 * Podman implementation of ContainerClient.
 */
export class PodmanContainerClient extends BaseContainerClient {
  static readonly runnerName = 'podman'

  constructor(config: ContainerConfig) {
    super(config)
  }

  protected getRunnerCommand(): string {
    return 'podman'
  }

  protected getAdditionalRunFlags(): string {
    return ''
  }

  /**
   * Podman needs :U on volume mounts to remap ownership to the container user.
   * Unlike Docker Desktop, Podman does not transparently handle UID mapping
   * for bind mounts — the host user's UID is preserved inside the container,
   * which prevents the non-root container user from writing to mounted volumes.
   */
  protected getVolumeMountSuffix(): string {
    return ':U'
  }

  /**
   * Check if Podman is available on the system.
   */
  static async isAvailable(): Promise<boolean> {
    return checkCommandAvailable('podman')
  }
}

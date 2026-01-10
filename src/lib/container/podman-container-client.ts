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

  /**
   * Podman-specific flags if needed.
   * For example, Podman might need --userns=keep-id for rootless mode.
   */
  protected getAdditionalRunFlags(): string {
    // Podman in rootless mode may need user namespace mapping
    // Uncomment if needed: return '--userns=keep-id'
    return ''
  }

  /**
   * Check if Podman is available on the system.
   */
  static async isAvailable(): Promise<boolean> {
    return checkCommandAvailable('podman')
  }
}

import { BaseContainerClient, checkCommandAvailable } from './base-container-client'
import type { ContainerConfig } from './types'

/**
 * Docker implementation of ContainerClient.
 */
export class DockerContainerClient extends BaseContainerClient {
  static readonly runnerName = 'docker'

  constructor(config: ContainerConfig) {
    super(config)
  }

  protected getRunnerCommand(): string {
    return 'docker'
  }

  protected getAdditionalRunFlags(): string {
    // On Linux, host.docker.internal isn't available by default.
    // This flag maps it to the host gateway. On macOS/Windows Docker Desktop
    // this is a no-op since host.docker.internal already resolves.
    if (process.platform === 'linux') {
      return '--add-host=host.docker.internal:host-gateway'
    }
    return ''
  }

  /**
   * Check if Docker is available on the system.
   */
  static async isAvailable(): Promise<boolean> {
    return checkCommandAvailable('docker')
  }
}

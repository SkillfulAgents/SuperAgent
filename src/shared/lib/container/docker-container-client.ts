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

  /**
   * Check if Docker is available on the system.
   */
  static async isAvailable(): Promise<boolean> {
    return checkCommandAvailable('docker')
  }
}

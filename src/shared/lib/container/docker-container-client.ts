import os from 'os'
import { BaseContainerClient, checkCommandAvailable, execWithPath } from './base-container-client'
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
   * On native Linux, containers reach the host via the docker bridge gateway
   * (host.docker.internal:host-gateway), which is the host's own docker0
   * interface address — a real host interface, NOT loopback. A host-side proxy
   * exposing the loopback CDP port must bind that gateway IP, never 0.0.0.0
   * (SUP-217). On macOS/Windows, Docker Desktop forwards host.docker.internal to
   * the host's loopback, so no bridge bind is needed (null).
   */
  getHostBridgeIp(): string | null {
    if (process.platform !== 'linux') return null
    // docker0 is a host interface; its IPv4 address is the bridge gateway the
    // container reaches the host through.
    const docker0 = os.networkInterfaces()['docker0']
    const v4 = docker0?.find((addr) => addr.family === 'IPv4' && !addr.internal)
    return v4?.address ?? null
  }

  /**
   * Check if Docker is available on the system.
   */
  static async isAvailable(): Promise<boolean> {
    return checkCommandAvailable('docker')
  }

  /**
   * Check if the Docker daemon is running and usable.
   */
  static async isRunning(): Promise<boolean> {
    try {
      await execWithPath('docker info')
      return true
    } catch {
      return false
    }
  }
}

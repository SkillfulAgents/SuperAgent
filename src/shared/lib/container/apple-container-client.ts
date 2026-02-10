import { execSync } from 'child_process'
import { BaseContainerClient, checkCommandAvailable, execWithPath, CONTAINER_INTERNAL_PORT } from './base-container-client'
import type { ContainerConfig, ContainerInfo, ContainerStats } from './types'

/** Cached macOS major version (null = not yet checked, undefined = not macOS) */
let cachedMacOSMajorVersion: number | null | undefined = undefined

/**
 * Get the macOS major version number, or null if not on macOS.
 * Result is cached for the lifetime of the process.
 */
function getMacOSMajorVersion(): number | null {
  if (cachedMacOSMajorVersion !== undefined) {
    return cachedMacOSMajorVersion
  }
  if (process.platform !== 'darwin') {
    cachedMacOSMajorVersion = null
    return null
  }
  try {
    const output = execSync('sw_vers -productVersion', { timeout: 5000 }).toString().trim()
    cachedMacOSMajorVersion = parseInt(output.split('.')[0], 10)
    return cachedMacOSMajorVersion
  } catch {
    cachedMacOSMajorVersion = null
    return null
  }
}

/**
 * Apple Container implementation of ContainerClient.
 * Uses the `container` CLI available on macOS 26+.
 */
export class AppleContainerClient extends BaseContainerClient {
  static readonly runnerName = 'apple-container'

  constructor(config: ContainerConfig) {
    super(config)
  }

  /**
   * Apple Container is only eligible on macOS 26+.
   */
  static isEligible(): boolean {
    const version = getMacOSMajorVersion()
    return version !== null && version >= 26
  }

  protected getRunnerCommand(): string {
    return 'container'
  }

  /**
   * Handle kernel-not-configured error on first use by auto-installing the recommended kernel.
   */
  protected async handleRunError(error: any): Promise<boolean> {
    if (error.message?.includes('kernel not configured')) {
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
      console.log(`Apple Container kernel not configured for ${arch}, installing recommended kernel...`)
      await execWithPath(`container system kernel set --arch ${arch} --recommended`)
      return true
    }
    return false
  }

  /**
   * Override: Apple's `container inspect` outputs JSON without --format support.
   * Parse the JSON to extract running state and port mappings.
   */
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    const containerName = this.getContainerName()
    const runner = this.getRunnerCommand()
    try {
      const { stdout } = await execWithPath(`${runner} inspect ${containerName}`)
      const data = JSON.parse(stdout)

      // Handle both possible formats: single object or array of objects
      const info = Array.isArray(data) ? data[0] : data

      // Extract running state (Apple uses top-level "status" field)
      const isRunning = info?.status === 'running'

      // Extract port mappings (Apple uses configuration.publishedPorts)
      let port: number | null = null
      const publishedPorts = info?.configuration?.publishedPorts
      if (Array.isArray(publishedPorts)) {
        const mapping = publishedPorts.find(
          (p: any) => p.containerPort === CONTAINER_INTERNAL_PORT
        )
        if (mapping?.hostPort) {
          port = mapping.hostPort
        }
      }

      return {
        status: isRunning ? 'running' : 'stopped',
        port,
      }
    } catch {
      return { status: 'stopped', port: null }
    }
  }

  /**
   * Override: Apple's `container list` uses --format json instead of Go templates.
   */
  protected async getUsedPorts(): Promise<Set<number>> {
    const usedPorts = new Set<number>()
    const runner = this.getRunnerCommand()
    try {
      const { stdout } = await execWithPath(`${runner} list --format json`)
      const containers = JSON.parse(stdout)
      if (Array.isArray(containers)) {
        for (const c of containers) {
          // Apple Container uses configuration.publishedPorts
          const ports = c.configuration?.publishedPorts || []
          if (Array.isArray(ports)) {
            for (const p of ports) {
              if (p.hostPort) usedPorts.add(p.hostPort)
            }
          }
        }
      }
    } catch {
      // If command fails, continue with empty set
    }
    return usedPorts
  }

  /**
   * Apple Container does not currently support `container stats`.
   */
  async getStats(): Promise<ContainerStats | null> {
    return null
  }

  /**
   * Check if the Apple Container CLI is available on the system.
   */
  static async isAvailable(): Promise<boolean> {
    return checkCommandAvailable('container')
  }

  /**
   * Check if the Apple Container services are running and usable.
   */
  static async isRunning(): Promise<boolean> {
    try {
      await execWithPath('container system status')
      return true
    } catch {
      return false
    }
  }
}

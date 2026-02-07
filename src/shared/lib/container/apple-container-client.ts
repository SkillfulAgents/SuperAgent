import { execSync } from 'child_process'
import { BaseContainerClient, checkCommandAvailable, execWithPath, CONTAINER_INTERNAL_PORT } from './base-container-client'
import type { ContainerConfig, ContainerInfo } from './types'

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

      // Extract running state
      const state = info?.State || info?.state
      const isRunning = state === 'running' ||
        state?.Status === 'running' ||
        state?.Running === true

      // Extract port mappings
      let port: number | null = null
      const ports = info?.NetworkSettings?.Ports || info?.Ports || info?.ports || {}
      const portKey = `${CONTAINER_INTERNAL_PORT}/tcp`

      if (ports[portKey]) {
        const binding = Array.isArray(ports[portKey]) ? ports[portKey][0] : ports[portKey]
        const hostPort = binding?.HostPort || binding?.hostPort
        if (hostPort) {
          port = parseInt(hostPort, 10)
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
          // Extract published ports from the container data
          const ports = c.Ports || c.ports || []
          if (Array.isArray(ports)) {
            for (const p of ports) {
              const hostPort = p.HostPort || p.hostPort
              if (hostPort) usedPorts.add(parseInt(hostPort, 10))
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

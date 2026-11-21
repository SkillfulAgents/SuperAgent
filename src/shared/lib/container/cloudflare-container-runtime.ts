/**
 * Runs each agent in a Cloudflare Container. The deployment that hosts the app on Cloudflare
 * installs how this process reaches its agents' containers (installCloudflareContainers), the way the
 * MicroVM controller serves the MicroVM runtime. Every call this client makes goes there, at
 * CLOUDFLARE_CONTAINER_ORIGIN:
 *
 * - `GET  /_control/{agentId}`: `{ "running": boolean }`
 * - `POST /_control/{agentId}/start` with `{ "env": {...} }`: starts the container
 * - `POST /_control/{agentId}/stop`: stops it; with `{ "discard": true }`, without saving its workspace
 * - `/{agentId}/{path}`: the agent's container API, HTTP and WebSocket
 */
import WebSocket from 'ws'
import { captureException } from '@shared/lib/error-reporting'
import { BaseContainerClient, CONTAINER_INTERNAL_PORT, withVolumesEnv } from './base-container-client'
import type { ContainerInfo, ContainerStats, StartOptions, StopOptions, StopResult } from './types'

const START_TIMEOUT_MS = 120_000

/** The origin of the calls in the contract above. They never go out: the installed `fetch` answers them. */
export const CLOUDFLARE_CONTAINER_ORIGIN = 'http://agent-container.internal'

/** How this process reaches its agents' containers. */
export interface CloudflareContainers {
  /** Answers a call of the contract above; only these calls are sent to it. */
  fetch(url: string, init?: RequestInit): Promise<Response>
  /** Where an agent's container reaches the host. */
  readonly hostUrl: string
}

let installed: CloudflareContainers | null = null

/** Set once at boot by the deployment, before the first container starts; null removes it. */
export function installCloudflareContainers(containers: CloudflareContainers | null): void {
  installed = containers
}

function containers(): CloudflareContainers {
  if (!installed) throw new Error('No Cloudflare containers are installed in this process (installCloudflareContainers)')
  return installed
}

export class CloudflareContainerRuntimeClient extends BaseContainerClient {
  static readonly runnerName = 'cloudflare-container'
  static readonly requiresLocalImage = false
  static readonly supportsCustomAgentImage = false

  // Each container's agent object watches it (`monitor()`) and hears it exit.
  readonly reportsExits = true

  private lastKnownInfo: ContainerInfo = { status: 'stopped', port: null }

  static isEligible(): boolean {
    return installed !== null
  }

  static async isAvailable(): Promise<boolean> {
    return this.isEligible()
  }

  static async isRunning(): Promise<boolean> {
    return this.isEligible()
  }

  protected getRunnerCommand(): string {
    return 'cloudflare-container'
  }

  protected getBaseUrl(_port: number): string {
    return `${CLOUDFLARE_CONTAINER_ORIGIN}/${encodeURIComponent(this.config.agentId)}`
  }

  public getWebSocketBaseUrl(port: number): string {
    return this.getBaseUrl(port).replace(/^http/, 'ws')
  }

  public getHostApiBaseUrl(): string {
    return containers().hostUrl
  }

  protected override request(url: string, init?: RequestInit): Promise<Response> {
    return containers().fetch(url, init)
  }

  // The Worker build's `ws` makes its upgrade request with the `fetch` it is given (src/cf/build/shims/ws.ts).
  protected override openWebSocket(url: string, headers: Record<string, string>): WebSocket {
    const options = { headers, fetch: (target: string, init: RequestInit) => containers().fetch(target, init) }
    return new WebSocket(url, options as WebSocket.ClientOptions)
  }

  async start(options?: StartOptions): Promise<ContainerInfo> {
    const info = await this.getInfoFromRuntime()
    if (info.status === 'running') {
      this.rememberRunningPort(CONTAINER_INTERNAL_PORT)
      options?.onAlreadyRunning?.()
      return info
    }
    const env = await this.buildAgentEnv(withVolumesEnv(options?.envVars, options?.volumes), options?.agentName)
    await this.control('POST', '/start', { env })
    this.lastKnownInfo = { status: 'running', port: CONTAINER_INTERNAL_PORT }
    this.rememberRunningPort(CONTAINER_INTERNAL_PORT)
    try {
      if (!(await this.waitForHealthy(START_TIMEOUT_MS, CONTAINER_INTERNAL_PORT))) {
        throw new Error(`Container for agent ${this.config.agentId} did not become healthy`)
      }
    } catch (error) {
      // An unhealthy container left running would be adopted, unchecked, by the next start().
      await this.control('POST', '/stop').catch(() => {})
      this.markStopped()
      throw error
    }
    return { status: 'running', port: CONTAINER_INTERNAL_PORT }
  }

  async stop(options?: StopOptions): Promise<StopResult> {
    this.terminateWebSocketConnections()
    await this.control('POST', '/stop', options?.forDeletion ? { discard: true } : undefined)
    this.markStopped()
    return { forceStopUsed: false, stopped: true }
  }

  // Stopping is an async call to the deployment; a sync shutdown only closes the sockets.
  stopSync(): void {
    this.terminateWebSocketConnections()
  }

  async getInfoFromRuntime(): Promise<ContainerInfo> {
    try {
      const { running } = (await (await this.control('GET', '')).json()) as { running: boolean }
      this.lastKnownInfo = running ? { status: 'running', port: CONTAINER_INTERNAL_PORT } : { status: 'stopped', port: null }
    } catch (error) {
      // A transient failure keeps the last known state, so one bad poll neither aborts a start nor stops a live agent.
      captureException(error, {
        tags: { area: 'container', op: 'cloudflare-container.getInfo' },
        extra: { agentId: this.config.agentId },
      })
    }
    return this.lastKnownInfo
  }

  async isDefinitelyStopped(): Promise<boolean> {
    try {
      return ((await (await this.control('GET', '/stopped')).json()) as { stopped: boolean }).stopped === true
    } catch {
      // An unreachable deployment proves nothing.
      return false
    }
  }

  async getStats(): Promise<ContainerStats | null> {
    return null
  }

  public volumeRunFlags(): string | null {
    return ''
  }

  private markStopped(): void {
    this.lastKnownInfo = { status: 'stopped', port: null }
    this.rememberRunningPort(null)
  }

  private async control(method: 'GET' | 'POST', action: '' | '/start' | '/stop' | '/stopped', body?: unknown): Promise<Response> {
    const path = `/_control/${encodeURIComponent(this.config.agentId)}${action}`
    const response = await containers().fetch(`${CLOUDFLARE_CONTAINER_ORIGIN}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new Error(`Cloudflare container ${method} ${path} failed: ${response.status} ${detail}`.trim())
    }
    return response
  }
}

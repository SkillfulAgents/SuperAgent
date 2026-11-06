/**
 * Runs each agent in a Cloudflare Container. The deployment that hosts the app on
 * Cloudflare serves this HTTP contract at CLOUDFLARE_CONTAINER_URL, the way the
 * MicroVM controller serves the MicroVM runtime:
 *
 * - `GET  {url}/_control/{agentId}`: `{ "running": boolean }`
 * - `POST {url}/_control/{agentId}/start` with `{ "env": {...} }`: starts the container
 * - `POST {url}/_control/{agentId}/stop`: stops it
 * - `{url}/{agentId}/{path}`: the agent's container API, HTTP and WebSocket
 *
 * Control calls carry `authorization: Bearer {CLOUDFLARE_CONTAINER_TOKEN}`.
 * The agent reaches the host at CLOUDFLARE_CONTAINER_HOST_URL.
 */
import { captureException } from '@shared/lib/error-reporting'
import { BaseContainerClient, CONTAINER_INTERNAL_PORT, withVolumesEnv } from './base-container-client'
import type { ContainerInfo, ContainerStats, StartOptions, StopOptions, StopResult } from './types'

const START_TIMEOUT_MS = 120_000

interface CloudflareContainerConfig {
  url: string
  hostUrl: string
  token: string
}

function cloudflareContainerConfig(): CloudflareContainerConfig | null {
  const url = process.env.CLOUDFLARE_CONTAINER_URL?.trim().replace(/\/+$/, '')
  const hostUrl = process.env.CLOUDFLARE_CONTAINER_HOST_URL?.trim().replace(/\/+$/, '')
  const token = process.env.CLOUDFLARE_CONTAINER_TOKEN?.trim()
  return url && hostUrl && token ? { url, hostUrl, token } : null
}

function requireConfig(): CloudflareContainerConfig {
  const config = cloudflareContainerConfig()
  if (!config) {
    throw new Error('Set CLOUDFLARE_CONTAINER_URL, CLOUDFLARE_CONTAINER_HOST_URL and CLOUDFLARE_CONTAINER_TOKEN to run agents in Cloudflare Containers')
  }
  return config
}

export class CloudflareContainerRuntimeClient extends BaseContainerClient {
  static readonly runnerName = 'cloudflare-container'
  static readonly requiresLocalImage = false
  static readonly supportsCustomAgentImage = false

  private lastKnownInfo: ContainerInfo = { status: 'stopped', port: null }

  static isEligible(): boolean {
    return cloudflareContainerConfig() !== null
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
    return `${requireConfig().url}/${encodeURIComponent(this.config.agentId)}`
  }

  public getWebSocketBaseUrl(port: number): string {
    return this.getBaseUrl(port).replace(/^http/, 'ws')
  }

  public getHostApiBaseUrl(): string {
    return requireConfig().hostUrl
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

  async stop(_options?: StopOptions): Promise<StopResult> {
    this.terminateWebSocketConnections()
    await this.control('POST', '/stop')
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

  private async control(method: 'GET' | 'POST', action: '' | '/start' | '/stop', body?: unknown): Promise<Response> {
    const { url, token } = requireConfig()
    const path = `/_control/${encodeURIComponent(this.config.agentId)}${action}`
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new Error(`Cloudflare container ${method} ${path} failed: ${response.status} ${detail}`.trim())
    }
    return response
  }
}

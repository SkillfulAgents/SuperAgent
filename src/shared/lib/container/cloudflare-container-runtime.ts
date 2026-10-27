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
 * The agent reaches the host at CLOUDFLARE_CONTAINER_HOST_URL.
 */
import { BaseContainerClient, CONTAINER_INTERNAL_PORT, withVolumesEnv } from './base-container-client'
import type { ContainerInfo, ContainerStats, StartOptions, StopOptions, StopResult } from './types'

const START_TIMEOUT_MS = 120_000

interface CloudflareContainerConfig {
  url: string
  hostUrl: string
}

function cloudflareContainerConfig(): CloudflareContainerConfig | null {
  const url = process.env.CLOUDFLARE_CONTAINER_URL?.trim().replace(/\/+$/, '')
  const hostUrl = process.env.CLOUDFLARE_CONTAINER_HOST_URL?.trim().replace(/\/+$/, '')
  return url && hostUrl ? { url, hostUrl } : null
}

function requireConfig(): CloudflareContainerConfig {
  const config = cloudflareContainerConfig()
  if (!config) {
    throw new Error('Set CLOUDFLARE_CONTAINER_URL and CLOUDFLARE_CONTAINER_HOST_URL to run agents in Cloudflare Containers')
  }
  return config
}

export class CloudflareContainerRuntimeClient extends BaseContainerClient {
  static readonly runnerName = 'cloudflare-container'
  static readonly requiresLocalImage = false
  static readonly supportsCustomAgentImage = false

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
    this.rememberRunningPort(CONTAINER_INTERNAL_PORT)
    if (!(await this.waitForHealthy(START_TIMEOUT_MS, CONTAINER_INTERNAL_PORT))) {
      throw new Error(`Container for agent ${this.config.agentId} did not become healthy`)
    }
    return { status: 'running', port: CONTAINER_INTERNAL_PORT }
  }

  async stop(_options?: StopOptions): Promise<StopResult> {
    this.terminateWebSocketConnections()
    await this.control('POST', '/stop')
    this.rememberRunningPort(null)
    return { forceStopUsed: false, stopped: true }
  }

  // Stopping is an async call to the deployment; a sync shutdown only closes the sockets.
  stopSync(): void {
    this.terminateWebSocketConnections()
  }

  async getInfoFromRuntime(): Promise<ContainerInfo> {
    const { running } = (await (await this.control('GET', '')).json()) as { running: boolean }
    return running ? { status: 'running', port: CONTAINER_INTERNAL_PORT } : { status: 'stopped', port: null }
  }

  async getStats(): Promise<ContainerStats | null> {
    return null
  }

  public volumeRunFlags(): string | null {
    return ''
  }

  private async control(method: 'GET' | 'POST', action: '' | '/start' | '/stop', body?: unknown): Promise<Response> {
    const path = `/_control/${encodeURIComponent(this.config.agentId)}${action}`
    const response = await fetch(`${requireConfig().url}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new Error(`Cloudflare container ${method} ${path} failed: ${response.status} ${detail}`.trim())
    }
    return response
  }
}

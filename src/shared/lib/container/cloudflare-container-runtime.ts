/**
 * Agent runtime on Cloudflare Containers: one container Durable Object per
 * agent. The host cannot dial a local port inside a Worker, so every call to
 * the container API goes through the container's Durable Object stub, and the
 * agent reaches the host at HOST_INTERNAL_ORIGIN, which the container's
 * outbound handler routes back to the host.
 */
import { EventEmitter } from 'events'
import type { WebSocket } from 'ws'
import { BaseContainerClient, CONTAINER_INTERNAL_PORT, withVolumesEnv } from './base-container-client'
import type { ContainerInfo, ContainerStats, StartOptions, StopOptions, StopResult } from './types'

export const HOST_INTERNAL_ORIGIN = 'http://host.internal'

export interface AgentContainerStub {
  startAgent(envVars: Record<string, string>): Promise<void>
  stopAgent(): Promise<void>
  agentRunning(): Promise<boolean>
  fetch(request: Request): Promise<Response>
}

export interface AgentContainerNamespace {
  idFromName(name: string): unknown
  get(id: unknown): AgentContainerStub
}

let namespace: AgentContainerNamespace | null = null

/** Called once by the Worker that owns the binding, before any agent starts. */
export function setAgentContainerNamespace(binding: AgentContainerNamespace): void {
  namespace = binding
}

/** The subset of the `ws` client the container client uses, over a Workers WebSocket. */
class StubWebSocket extends EventEmitter {
  private socket: globalThis.WebSocket | null = null
  private closed = false

  constructor(stub: AgentContainerStub, url: string, headers: Record<string, string>, protocols?: string | string[]) {
    super()
    void this.connect(stub, url, headers, protocols)
  }

  private async connect(stub: AgentContainerStub, url: string, headers: Record<string, string>, protocols?: string | string[]) {
    try {
      const requestHeaders = new Headers(headers)
      requestHeaders.set('Upgrade', 'websocket')
      if (protocols) requestHeaders.set('Sec-WebSocket-Protocol', [protocols].flat().join(', '))
      const response = await stub.fetch(new Request(url.replace(/^ws/, 'http'), { headers: requestHeaders }))
      const socket = (response as Response & { webSocket?: globalThis.WebSocket & { accept(): void } }).webSocket
      if (!socket) throw new Error(`WebSocket upgrade refused with status ${response.status}`)
      socket.accept()
      if (this.closed) {
        socket.close(1000)
        return
      }
      this.socket = socket
      socket.addEventListener('message', (event) => {
        const data = event.data
        this.emit('message', typeof data === 'string' ? Buffer.from(data) : Buffer.from(data as ArrayBuffer), typeof data !== 'string')
      })
      socket.addEventListener('close', (event) => this.emit('close', event.code, Buffer.from(event.reason ?? '')))
      socket.addEventListener('error', () => this.emit('error', new Error('Container WebSocket error')))
      this.emit('open')
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
      this.emit('close', 1006, Buffer.alloc(0))
    }
  }

  get readyState(): number {
    return this.socket?.readyState ?? (this.closed ? 3 : 0)
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.socket?.send(data)
  }

  close(code = 1000, reason?: string): void {
    this.closed = true
    this.socket?.close(code, reason)
  }

  terminate(): void {
    this.close()
  }
}

export class CloudflareContainerRuntimeClient extends BaseContainerClient {
  static readonly runnerName = 'cloudflare-container'
  static readonly requiresLocalImage = false
  static readonly supportsCustomAgentImage = false

  static isEligible(): boolean {
    return namespace !== null
  }

  static async isAvailable(): Promise<boolean> {
    return namespace !== null
  }

  static async isRunning(): Promise<boolean> {
    return namespace !== null
  }

  protected getRunnerCommand(): string {
    return 'cloudflare-container'
  }

  private stub(): AgentContainerStub {
    if (!namespace) throw new Error('No Cloudflare container binding is registered')
    return namespace.get(namespace.idFromName(this.config.agentId))
  }

  async start(options?: StartOptions): Promise<ContainerInfo> {
    const info = await this.getInfoFromRuntime()
    if (info.status === 'running') {
      this.rememberRunningPort(CONTAINER_INTERNAL_PORT)
      options?.onAlreadyRunning?.()
      return info
    }
    const env = await this.buildAgentEnv(withVolumesEnv(options?.envVars, options?.volumes), options?.agentName)
    await this.stub().startAgent(env)
    this.rememberRunningPort(CONTAINER_INTERNAL_PORT)
    if (!(await this.waitForHealthy(120_000, CONTAINER_INTERNAL_PORT))) {
      throw new Error(`Cloudflare container for agent ${this.config.agentId} failed to become healthy`)
    }
    return { status: 'running', port: CONTAINER_INTERNAL_PORT }
  }

  async stop(_options?: StopOptions): Promise<StopResult> {
    this.terminateWebSocketConnections()
    await this.stub().stopAgent()
    this.rememberRunningPort(null)
    return { forceStopUsed: false, stopped: true }
  }

  stopSync(): void {
    this.terminateWebSocketConnections()
  }

  async getInfoFromRuntime(): Promise<ContainerInfo> {
    return (await this.stub().agentRunning())
      ? { status: 'running', port: CONTAINER_INTERNAL_PORT }
      : { status: 'stopped', port: null }
  }

  async getStats(): Promise<ContainerStats | null> {
    return null
  }

  public volumeRunFlags(): string | null {
    return ''
  }

  public getHostApiBaseUrl(): string {
    return HOST_INTERNAL_ORIGIN
  }

  protected transportFetch(url: string, init?: RequestInit): Promise<Response> {
    return this.stub().fetch(new Request(url, init))
  }

  public openWebSocket(url: string, headers: Record<string, string>, protocols?: string | string[]): WebSocket {
    return new StubWebSocket(this.stub(), url, headers, protocols) as unknown as WebSocket
  }
}

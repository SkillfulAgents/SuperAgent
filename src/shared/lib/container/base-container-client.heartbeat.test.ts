import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'
import { WebSocketServer } from 'ws'
import type { ContainerConfig, ContainerInfo, StreamMessage } from './types'
import { BaseContainerClient } from './base-container-client'

vi.mock('@shared/lib/container/host-token-store', () => ({
  getOrCreateHostToken: () => 'test-host-token',
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ enableToolSearch: true }),
}))
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({ getContainerEnvVars: () => ({}) }),
}))

class HeartbeatClient extends BaseContainerClient {
  constructor(private readonly port: number) {
    super({ agentId: 'test-agent' } as ContainerConfig)
    this.streamHeartbeatIntervalMs = 40
  }
  protected getRunnerCommand(): string {
    return 'docker'
  }
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    return { status: 'running', port: this.port }
  }
}

async function startServer(autoPong: boolean): Promise<WebSocketServer> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong })
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'status', data: { message: 'Connected to session stream' } }))
  })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  return server
}

describe('session stream heartbeat', () => {
  let server: WebSocketServer | undefined

  afterEach(async () => {
    const closing = server
    server = undefined
    if (!closing) return
    for (const socket of closing.clients) socket.terminate()
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  })

  it('reports connection_closed when the peer stops answering pings', async () => {
    server = await startServer(false)
    const client = new HeartbeatClient((server.address() as AddressInfo).port)
    const messages: StreamMessage[] = []
    const closed = new Promise<void>((resolve) => {
      client.subscribeToStream('sess-silent', (message) => {
        messages.push(message)
        if (message.type === 'connection_closed') resolve()
      })
    })

    await closed
    expect(messages.map((m) => m.type)).toEqual(['status', 'connection_closed'])
  })

  it('keeps a responsive stream open', async () => {
    server = await startServer(true)
    const client = new HeartbeatClient((server.address() as AddressInfo).port)
    const types: string[] = []
    const { unsubscribe, ready } = client.subscribeToStream('sess-live', (message) => {
      types.push(message.type)
    })
    await ready
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(types).toEqual(['status'])
    unsubscribe()
  })
})

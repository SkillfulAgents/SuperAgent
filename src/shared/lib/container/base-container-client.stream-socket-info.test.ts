import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import type { ContainerConfig, ContainerInfo } from './types'
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

class RunningPortClient extends BaseContainerClient {
  constructor(private readonly port: number) {
    super({ agentId: 'test-agent' } as ContainerConfig)
  }
  protected getRunnerCommand(): string {
    return 'docker'
  }
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    return { status: 'running', port: this.port }
  }
}

describe('getStreamSocketInfo', () => {
  let server: WebSocketServer | undefined

  afterEach(async () => {
    const closing = server
    server = undefined
    await new Promise<void>((resolve) => closing?.close(() => resolve()) ?? resolve())
  })

  it('reports the frames and TCP state of the tracked stream socket', async () => {
    let guest!: ServerSocket
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    server.on('connection', (socket) => {
      guest = socket
      socket.send(JSON.stringify({ type: 'status', data: { message: 'Connected to session stream' } }))
    })
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()))
    const client = new RunningPortClient((server.address() as AddressInfo).port)

    expect(client.getStreamSocketInfo('sess-1')).toBeNull()

    const received: string[] = []
    const { ready, unsubscribe } = client.subscribeToStream('sess-1', (m) => received.push(m.type))
    await ready
    guest.send(JSON.stringify({ type: 'assistant', message: { content: 'Here is the summary.' } }))
    await vi.waitFor(() => expect(received).toContain('assistant'))

    const info = client.getStreamSocketInfo('sess-1')
    expect(info).toMatchObject({
      readyState: 'OPEN',
      framesReceived: 2,
      bufferedAmount: 0,
      tcpDestroyed: false,
    })
    expect(info!.tcpBytesRead).toBeGreaterThan(0)
    expect(Date.parse(info!.lastFrameAt!)).toBeGreaterThanOrEqual(Date.parse(info!.openedAt!))

    unsubscribe()
    expect(client.getStreamSocketInfo('sess-1')).toBeNull()
  })
})

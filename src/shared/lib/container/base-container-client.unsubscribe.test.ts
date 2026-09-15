import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ContainerConfig, ContainerInfo, StreamMessage } from './types'
import { BaseContainerClient } from './base-container-client'

const { FakeWebSocket, sockets } = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1
    static autoHandshake = true
    url: string
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    closed = false

    constructor(url: string) {
      this.url = url
      sockets.push(this)
      queueMicrotask(() => {
        this.emit('open')
        if (FakeWebSocket.autoHandshake) {
          this.receive({ type: 'status', data: { message: 'Connected to session stream' } })
        }
      })
    }

    on(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? []
      list.push(fn)
      this.listeners.set(event, list)
      return this
    }

    removeAllListeners(): void {
      this.listeners.clear()
    }

    close(): void {
      this.closed = true
      queueMicrotask(() => this.emit('close'))
    }

    terminate(): void {
      this.close()
    }

    receive(message: Record<string, unknown>): void {
      this.emit('message', Buffer.from(JSON.stringify(message)))
    }

    emit(event: string, ...args: unknown[]): void {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args)
    }
  }

  const sockets: FakeWebSocket[] = []
  return { FakeWebSocket, sockets }
})

vi.mock('ws', () => ({ default: FakeWebSocket }))
vi.mock('@shared/lib/container/host-token-store', () => ({
  getOrCreateHostToken: () => 'test-host-token',
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ enableToolSearch: true }),
}))
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({ getContainerEnvVars: () => ({}) }),
}))

class RunningTestClient extends BaseContainerClient {
  terminateConnections(): void {
    this.terminateWebSocketConnections()
  }
  protected getRunnerCommand(): string {
    return 'docker'
  }
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    return { status: 'running', port: 12345 }
  }
}

function makeClient(): RunningTestClient {
  return new RunningTestClient({ agentId: 'test-agent' } as ContainerConfig)
}

describe('subscribeToStream unsubscribe', () => {
  beforeEach(() => {
    sockets.length = 0
    FakeWebSocket.autoHandshake = true
  })

  it('resolves ready only after delayed replay and the guest acknowledgement', async () => {
    FakeWebSocket.autoHandshake = false
    const messages: StreamMessage[] = []
    const { ready, unsubscribe } = makeClient().subscribeToStream('sess-1', m => messages.push(m))
    let initialized = false
    void ready.then(() => { initialized = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(initialized).toBe(false)
    const socket = sockets[0]
    socket.receive({ type: 'system', subtype: 'capabilities', session_state_events: true })
    socket.receive({ type: 'result', subtype: 'success', replayed: true })
    socket.receive({ type: 'system', subtype: 'session_state_changed', state: 'idle', replayed: true })
    socket.receive({ type: 'status', data: { message: 'Still initializing' } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(initialized).toBe(false)
    socket.receive({ type: 'status', data: { message: 'Connected to session stream' } })
    await ready
    expect(initialized).toBe(true)
    expect(messages.map(m => m.content.type)).toEqual(['system', 'result', 'system', 'status', 'status'])
    unsubscribe()
  })

  it.each(['close', 'error', 'unsubscribe', 'stop'])('rejects ready on %s before the acknowledgement', async (event) => {
    FakeWebSocket.autoHandshake = false
    const client = makeClient()
    const { ready, unsubscribe } = client.subscribeToStream('sess-1', () => {})
    const rejection = expect(ready).rejects.toThrow(/before initialization|connection failed/)
    await new Promise(resolve => setTimeout(resolve, 0))
    if (event === 'unsubscribe') unsubscribe()
    else if (event === 'stop') client.terminateConnections()
    else sockets[0].emit(event, new Error('connection failed'))
    await rejection
    unsubscribe()
  })

  it('cancels an attachment before port discovery finishes without opening a socket', async () => {
    const client = makeClient()
    let resolvePort!: (info: ContainerInfo) => void
    vi.spyOn(client, 'getInfoFromRuntime').mockImplementationOnce(() =>
      new Promise(resolve => { resolvePort = resolve }))
    const { ready, unsubscribe } = client.subscribeToStream('sess-1', () => {})
    const rejection = expect(ready).rejects.toThrow('unsubscribed before initialization')
    unsubscribe()
    resolvePort({ status: 'running', port: 12345 })
    await rejection
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sockets).toHaveLength(0)
  })

  it('rejects a replaced attachment and keeps the new socket when the old caller unsubscribes', async () => {
    FakeWebSocket.autoHandshake = false
    const client = makeClient()
    const first = client.subscribeToStream('sess-1', () => {})
    const rejection = expect(first.ready).rejects.toThrow('closed before initialization')
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = client.subscribeToStream('sess-1', () => {})
    await rejection
    sockets[1].receive({ type: 'status', data: { message: 'Connected to session stream' } })
    await second.ready
    first.unsubscribe()
    expect(sockets[1].closed).toBe(false)
    second.unsubscribe()
  })

  it('does not route connection_closed on a deliberate unsubscribe', async () => {
    const client = makeClient()
    const messages: StreamMessage[] = []
    const { unsubscribe, ready } = client.subscribeToStream('sess-1', (m) => messages.push(m))
    await ready

    unsubscribe()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sockets[0].closed).toBe(true)
    expect(messages.some((m) => m.type === 'connection_closed')).toBe(false)
  })

  it('still routes connection_closed when the socket drops on its own', async () => {
    const client = makeClient()
    const messages: StreamMessage[] = []
    const { ready } = client.subscribeToStream('sess-1', (m) => messages.push(m))
    await ready

    sockets[0].emit('close')

    expect(messages.filter(m => m.type === 'connection_closed')).toEqual([
      expect.objectContaining({ type: 'connection_closed', sessionId: 'sess-1' }),
    ])
  })

  it('does not let a stale close delete a newer socket after resubscribe', async () => {
    const client = makeClient()
    const first: StreamMessage[] = []
    const second: StreamMessage[] = []

    const firstSub = client.subscribeToStream('sess-1', (m) => first.push(m))
    await firstSub.ready
    const firstSocket = sockets[0]

    firstSub.unsubscribe()
    const secondSub = client.subscribeToStream('sess-1', (m) => second.push(m))
    await secondSub.ready
    await new Promise((resolve) => setTimeout(resolve, 0))

    firstSocket.emit('close')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(first.some((m) => m.type === 'connection_closed')).toBe(false)
    expect(second.some((m) => m.type === 'connection_closed')).toBe(false)

    secondSub.unsubscribe()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sockets[1].closed).toBe(true)
  })
})

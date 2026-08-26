import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ContainerConfig, ContainerInfo, StreamMessage } from './types'
import { BaseContainerClient } from './base-container-client'

const { FakeWebSocket, sockets } = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1
    url: string
    private listeners = new Map<string, Array<() => void>>()
    closed = false

    constructor(url: string) {
      this.url = url
      sockets.push(this)
      queueMicrotask(() => this.emit('open'))
    }

    on(event: string, fn: () => void): this {
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

    emit(event: string): void {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn()
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

    expect(messages).toHaveLength(1)
    expect(messages[0].type).toBe('connection_closed')
    expect(messages[0].sessionId).toBe('sess-1')
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

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { BaseContainerClient } from './base-container-client'
import type { ContainerConfig, ContainerInfo, StreamMessage } from './types'

// ============================================================================
// subscribeToStream — resume cursors, socket identity guards, Zod envelope
// ============================================================================

/**
 * Controllable stand-in for the `ws` module. Hand-rolled listener registry
 * (vi.hoisted runs before module imports, so extending Node's EventEmitter is
 * not an option here). close()/terminate() are deliberate no-ops: a real
 * socket's 'close' arrives asynchronously, so tests emit it by hand to model
 * the replaced-socket race.
 */
const { FakeWebSocket } = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1
    static instances: FakeWebSocket[] = []
    readonly url: string
    readyState = 1
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    constructor(url: string) {
      this.url = url
      FakeWebSocket.instances.push(this)
    }

    ping(): void {}

    on(event: string, listener: (...args: unknown[]) => void): this {
      const existing = this.listeners.get(event) ?? []
      existing.push(listener)
      this.listeners.set(event, existing)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args)
      }
    }

    removeAllListeners(): this {
      this.listeners.clear()
      return this
    }

    close(): void {}
    terminate(): void {}
  }
  return { FakeWebSocket }
})

vi.mock('ws', () => ({ default: FakeWebSocket }))

/** Minimal concrete client whose container reports as running, so
 * subscribeToStream's getPortOrThrow resolves and a socket is created. */
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

/** Socket creation happens after an awaited getPortOrThrow, so tests wait for
 * the fake constructor to have run before emitting events on it. */
async function socketAt(index: number): Promise<InstanceType<typeof FakeWebSocket>> {
  await vi.waitFor(() => {
    expect(FakeWebSocket.instances.length).toBeGreaterThan(index)
  })
  return FakeWebSocket.instances[index]
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0
})

describe('subscribeToStream connection lifecycle', () => {
  it('delivers exactly one connection_closed when the tracked socket closes', async () => {
    const client = makeClient()
    const received: StreamMessage[] = []
    const { ready } = client.subscribeToStream('sess-a', (m) => received.push(m))

    const ws = await socketAt(0)
    ws.emit('open')
    await ready

    ws.emit('close')
    // A second close from the same (now untracked) socket must stay silent.
    ws.emit('close')

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('connection_closed')
    expect(received[0].sessionId).toBe('sess-a')
  })

  it('a replaced socket closes silently; only the tracked socket reports connection_closed', async () => {
    const client = makeClient()
    const cb1 = vi.fn<(m: StreamMessage) => void>()
    const cb2 = vi.fn<(m: StreamMessage) => void>()

    const sub1 = client.subscribeToStream('sess-b', cb1)
    sub1.ready.catch(() => {})
    const ws1 = await socketAt(0)
    ws1.emit('open')
    await sub1.ready

    // Re-subscribe for the same session: ws2 replaces ws1 in the map.
    const sub2 = client.subscribeToStream('sess-b', cb2)
    sub2.ready.catch(() => {})
    const ws2 = await socketAt(1)
    ws2.emit('open')
    await sub2.ready

    // The old socket's close arrives late (fake close() is a no-op, so this
    // models the real async close). Identity guard: nobody hears it.
    ws1.emit('close')
    expect(cb1).not.toHaveBeenCalled()
    expect(cb2).not.toHaveBeenCalled()

    ws2.emit('close')
    expect(cb1).not.toHaveBeenCalled()
    expect(cb2).toHaveBeenCalledTimes(1)
    expect(cb2.mock.calls[0][0].type).toBe('connection_closed')
  })

  it("ignores 'error' from a replaced socket but emits it for the tracked one", async () => {
    const client = makeClient()
    const errorSpy = vi.fn()
    client.on('error', errorSpy)

    const sub1 = client.subscribeToStream('sess-c', () => {})
    sub1.ready.catch(() => {})
    const ws1 = await socketAt(0)

    const sub2 = client.subscribeToStream('sess-c', () => {})
    sub2.ready.catch(() => {})
    const ws2 = await socketAt(1)

    ws1.emit('error', new Error('stale socket error'))
    expect(errorSpy).not.toHaveBeenCalled()

    ws2.emit('error', new Error('live socket error'))
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect((errorSpy.mock.calls[0][0] as Error).message).toBe('live socket error')
  })
})

describe('subscribeToStream resume cursor', () => {
  it('appends epoch and since_seq query params when a cursor is given', async () => {
    const client = makeClient()
    const sub = client.subscribeToStream('sess-d', () => {}, { epoch: 'e1', sinceSeq: 5 })
    sub.ready.catch(() => {})

    const ws = await socketAt(0)
    expect(ws.url.endsWith('/sessions/sess-d/stream?epoch=e1&since_seq=5')).toBe(true)
  })

  it('omits query params when no cursor is given', async () => {
    const client = makeClient()
    const sub = client.subscribeToStream('sess-d2', () => {})
    sub.ready.catch(() => {})

    const ws = await socketAt(0)
    expect(ws.url).not.toContain('?')
    expect(ws.url.endsWith('/sessions/sess-d2/stream')).toBe(true)
  })
})

describe('subscribeToStream liveness (ping/pong)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('terminates a half-open socket after a missed pong window and reports the loss', async () => {
    const client = makeClient()
    const received: StreamMessage[] = []
    const sub = client.subscribeToStream('sess-f', (m) => received.push(m))
    sub.ready.catch(() => {})
    const ws = await socketAt(0)

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const ping = vi.spyOn(ws, 'ping')
    const terminate = vi.spyOn(ws, 'terminate')
    ws.emit('open')
    await sub.ready

    // First window: ping goes out, nothing answers.
    vi.advanceTimersByTime(30_000)
    expect(ping).toHaveBeenCalledTimes(1)
    expect(terminate).not.toHaveBeenCalled()

    // Second window with no pong: the peer is gone — terminate.
    vi.advanceTimersByTime(30_000)
    expect(terminate).toHaveBeenCalledTimes(1)

    // The real socket fires 'close' after terminate; that is the recovery path.
    ws.emit('close')
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('connection_closed')

    // The timer died with the socket: no pings after close.
    vi.advanceTimersByTime(120_000)
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('a responsive socket is never terminated', async () => {
    const client = makeClient()
    const sub = client.subscribeToStream('sess-g', () => {})
    sub.ready.catch(() => {})
    const ws = await socketAt(0)

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const ping = vi.spyOn(ws, 'ping')
    const terminate = vi.spyOn(ws, 'terminate')
    ws.emit('open')
    await sub.ready

    for (let i = 1; i <= 3; i++) {
      vi.advanceTimersByTime(30_000)
      expect(ping).toHaveBeenCalledTimes(i)
      ws.emit('pong')
    }
    expect(terminate).not.toHaveBeenCalled()
  })
})

describe('subscribeToStream envelope validation', () => {
  it('drops frames that fail the envelope schema and keeps the subscription alive', async () => {
    const client = makeClient()
    const received: StreamMessage[] = []
    const sub = client.subscribeToStream('sess-e', (m) => received.push(m))
    sub.ready.catch(() => {})

    const ws = await socketAt(0)
    ws.emit('open')
    await sub.ready

    // Not JSON at all.
    ws.emit('message', 'not json')
    expect(received).toHaveLength(0)

    // Valid JSON but missing the required `type` field.
    ws.emit('message', '{"foo":1}')
    expect(received).toHaveLength(0)

    // A valid frame still gets through — bad frames didn't kill the handler.
    ws.emit('message', '{"type":"system","subtype":"capabilities"}')
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('system')
    expect(received[0].content).toMatchObject({ type: 'system', subtype: 'capabilities' })
    expect(received[0].sessionId).toBe('sess-e')
  })
})

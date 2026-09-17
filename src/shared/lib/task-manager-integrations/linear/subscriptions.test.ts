import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClient } from './client'
const state = vi.hoisted(() => ({ sockets: [] as unknown[] }))
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  class Socket extends EventEmitter {
    static OPEN = 1
    readyState = 1
    sent: Array<Record<string, unknown>> = []
    constructor(readonly url: string, readonly protocol: string, readonly options: unknown) { super(); state.sockets.push(this) }
    send(value: string) { this.sent.push(JSON.parse(value)) }
    close(code = 1000) { if (this.readyState !== 3) { this.readyState = 3; this.emit('close', code) } }
    terminate() { this.close() }
    frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))) }
  }
  return { default: Socket }
})
import WebSocket from 'ws'
import { LinearSubscriptions } from './subscriptions'
interface FakeSocket extends EventEmitter {
  url: string; protocol: string; options: { headers: Record<string, string> }; sent: Array<Record<string, unknown>>;
  close(): void; frame(value: unknown): void; readyState: number;
}
function socket(index = state.sockets.length - 1) { return state.sockets[index] as FakeSocket }
let transport: LinearSubscriptions
let wake: ReturnType<typeof vi.fn<() => void>>
let error: ReturnType<typeof vi.fn<(error: Error) => void>>
let authorization: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers(); state.sockets = []; wake = vi.fn(); error = vi.fn()
  authorization = vi.fn(async () => ({ accessToken: 'app-token', expiresAt: Date.now() + 3600000 }))
  transport = new LinearSubscriptions({ client: { authorization } as unknown as LinearClient, appUserId: 'app', isTracked: id => id === 'issue', onWake: wake, onError: error })
})
afterEach(() => { transport.stop(); vi.useRealTimers() })
async function connect() { transport.start(); await vi.advanceTimersByTimeAsync(0); socket().emit('open'); socket().frame({ type: 'connection_ack' }); await vi.advanceTimersByTimeAsync(12000) }
describe('Linear subscription transport', () => {
  it('paces registration and cancels unfinished subscriptions on disconnect', async () => {
    transport.start(); await vi.advanceTimersByTimeAsync(0)
    socket().frame({ type: 'connection_ack' })
    expect(socket().sent.filter(frame => frame.type === 'subscribe')).toHaveLength(1)
    expect(wake).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    expect(socket().sent.filter(frame => frame.type === 'subscribe')).toHaveLength(2)
    transport.stop()
    await vi.advanceTimersByTimeAsync(12000)
    expect(socket().sent.filter(frame => frame.type === 'subscribe')).toHaveLength(2)
    expect(wake).not.toHaveBeenCalled()
  })

  it('authenticates the upgrade, subscribes after ACK, catches up, and filters unrelated wakeups', async () => {
    await connect()
    expect(socket().url).toBe('wss://api.linear.app/graphql')
    expect(socket().protocol).toBe('graphql-transport-ws')
    expect(socket().options.headers.Authorization).toBe('Bearer app-token')
    expect(socket().sent[0]).toEqual({ type: 'connection_init' })
    expect(socket().sent.some(frame => frame.type === 'subscribe' && frame.id === 'notificationCreated')).toBe(true)
    expect(wake).toHaveBeenCalledTimes(1)
    socket().frame({ type: 'next', id: 'commentCreated', payload: { data: { commentCreated: { issue: { id: 'other' } } } } })
    expect(wake).toHaveBeenCalledTimes(1)
    socket().frame({ type: 'next', id: 'commentCreated', payload: { data: { commentCreated: { issue: { id: 'issue' } } } } })
    socket().frame({ type: 'next', id: 'notificationCreated', payload: { data: { notificationCreated: { id: 'mention' } } } })
    expect(wake).toHaveBeenCalledTimes(3)
    socket().frame({ type: 'connection_ack' })
    expect(wake).toHaveBeenCalledTimes(3)
  })
  it('reconnects after a lost heartbeat and schedules a new catch-up', async () => {
    await connect()
    await vi.advanceTimersByTimeAsync(81000)
    expect(state.sockets).toHaveLength(2)
    expect(transport.isReady()).toBe(false)
    socket().frame({ type: 'connection_ack' })
    await vi.advanceTimersByTimeAsync(12000)
    expect(wake).toHaveBeenCalledTimes(2)
    expect(authorization).toHaveBeenCalledTimes(2)
  })
  it('keeps healthy subscriptions alive when one operation is rejected, with polling covering the gap', async () => {
    transport.start(); await vi.advanceTimersByTimeAsync(0)
    socket().frame({ type: 'connection_ack' })
    socket().frame({ type: 'error', id: 'notificationCreated', payload: [] })
    await vi.advanceTimersByTimeAsync(12000)
    expect(socket().sent.filter(frame => frame.type === 'subscribe')).toHaveLength(9)
    expect(transport.isReady()).toBe(false)
    const wakes = wake.mock.calls.length
    socket().frame({ type: 'next', id: 'commentCreated', payload: { data: { commentCreated: { issue: { id: 'issue' } } } } })
    expect(wake).toHaveBeenCalledTimes(wakes + 1)
    for (let tick = 0; tick < 10; tick++) {
      socket().frame({ type: 'pong' })
      socket().frame({ type: 'error', id: 'notificationCreated', payload: [] })
      await vi.advanceTimersByTimeAsync(30000)
    }
    expect(state.sockets).toHaveLength(1)
    expect(error).toHaveBeenCalledOnce()
    socket().close()
    await vi.advanceTimersByTimeAsync(1000)
    socket().frame({ type: 'connection_ack' })
    await vi.advanceTimersByTimeAsync(12000)
    expect(socket().sent.some(frame => frame.id === 'notificationCreated')).toBe(false)
    expect(transport.isReady()).toBe(false)
  })
  it('backs off connection-level failures even when the handshake succeeds', async () => {
    await connect()
    socket().frame({ type: 'error', payload: [] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.sockets).toHaveLength(2)
    socket().frame({ type: 'connection_ack' })
    socket().frame({ type: 'error', payload: [] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.sockets).toHaveLength(3)
  })
  it('renews authentication before expiry and cancels reconnects on disconnect', async () => {
    authorization.mockResolvedValue({ accessToken: 'token', expiresAt: Date.now() + 65000 })
    await connect()
    await vi.advanceTimersByTimeAsync(6000)
    expect(authorization).toHaveBeenCalledTimes(2)
    transport.stop()
    await vi.advanceTimersByTimeAsync(120000)
    expect(authorization).toHaveBeenCalledTimes(2)
    expect(socket().readyState).not.toBe(WebSocket.OPEN)
  })
  it('does not open a socket if disconnected while obtaining a token', async () => {
    let resolve!: (value: { accessToken: string; expiresAt: number }) => void
    authorization.mockReturnValue(new Promise(done => { resolve = done }))
    transport.start(); transport.stop()
    resolve({ accessToken: 'token', expiresAt: Date.now() + 3600000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.sockets).toHaveLength(0)
  })
})

import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkerWebSocket } from 'cloudflare:workers'
import { WebSocket } from './ws'

type Handler = (event: Record<string, unknown>) => void

function fakeSocket() {
  const handlers = new Map<string, Handler>()
  const socket = {
    readyState: 1,
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    send: () => {},
    accept: () => {},
    close: () => {},
  } as unknown as WorkerWebSocket
  return { socket, deliver: (type: string, event: Record<string, unknown>) => handlers.get(type)!(event) }
}

/** A socket the shim opened: the upgrade is answered with `socket`, as the runtime's fetch answers one. */
async function connected(socket: WorkerWebSocket, make: () => WebSocket = () => new WebSocket('wss://relay.example.com/socket')): Promise<WebSocket> {
  vi.stubGlobal('fetch', async () => ({ status: 101, headers: new Headers(), webSocket: socket }))
  const ws = make()
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))
  return ws
}

describe('ws shim', () => {
  afterEach(() => void vi.unstubAllGlobals())

  it('makes the upgrade request with the fetch it is given, not the global one', async () => {
    const global = vi.fn(); vi.stubGlobal('fetch', global)
    const { socket } = fakeSocket()
    const upgrade = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 101, headers: new Headers(), webSocket: socket }) as unknown as Response)
    const ws = new WebSocket('ws://container/sessions/session-1/stream', { headers: { 'x-superagent-host-token': 'token-1' }, fetch: upgrade })
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))

    expect(upgrade.mock.calls[0][0]).toBe('http://container/sessions/session-1/stream')
    expect(new Headers(upgrade.mock.calls[0][1].headers).get('x-superagent-host-token')).toBe('token-1')
    expect(global).not.toHaveBeenCalled()
  })

  it('runs listeners in the async context the socket was made in', async () => {
    const owner = new AsyncLocalStorage<string>()
    const { socket, deliver } = fakeSocket()
    const ws = await connected(socket, () => owner.run('agent-object', () => new WebSocket('wss://relay.example.com/socket')))
    const seen: Array<string | undefined> = []
    ws.on('message', () => seen.push(owner.getStore()))
    ws.onmessage = () => seen.push(owner.getStore())
    ws.on('close', () => seen.push(owner.getStore()))

    // The runtime delivers events outside any context.
    deliver('message', { data: 'session settled' })
    deliver('close', { code: 1000, reason: '' })

    expect(seen).toEqual(['agent-object', 'agent-object', 'agent-object'])
  })

  it('ends at once on terminate, without waiting for the other side to answer the close', async () => {
    const { socket, deliver } = fakeSocket()
    const ws = await connected(socket)
    const closes: number[] = []
    ws.on('close', (code: number) => closes.push(code))

    ws.terminate()
    expect(closes).toEqual([1006])
    expect(ws.readyState).toBe(WebSocket.CLOSED)

    // The runtime's own close event, if it ever comes, is not a second close.
    deliver('close', { code: 1000, reason: '' })
    expect(closes).toEqual([1006])
  })

  it('answers a ping with a pong only while the runtime holds the connection open', async () => {
    const { socket } = fakeSocket()
    const ws = await connected(socket)
    let pongs = 0
    ws.on('pong', () => pongs++)

    ws.ping()
    await Promise.resolve()
    expect(pongs).toBe(1)

    // The runtime lost the connection and has not delivered a close event.
    ;(socket as unknown as { readyState: number }).readyState = 3
    ws.ping()
    await Promise.resolve()
    expect(pongs).toBe(1)
  })

  it('wraps a socket the Worker accepted, with no upgrade request', async () => {
    const global = vi.fn(); vi.stubGlobal('fetch', global)
    const { socket, deliver } = fakeSocket()
    const sent: unknown[] = []
    ;(socket as unknown as { send: (data: unknown) => void }).send = (data) => sent.push(data)
    const ws = WebSocket.accepted(socket)
    const messages: Array<[string, boolean]> = []
    ws.on('message', (data, isBinary) => messages.push([String(data), isBinary]))

    deliver('message', { data: '{"type":"viewport","width":800}' })
    ws.send(Buffer.from('frame'), { binary: true })

    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(messages).toEqual([['{"type":"viewport","width":800}', false]])
    expect(sent).toHaveLength(1)
    expect(global).not.toHaveBeenCalled()
  })

  it('offers no subprotocol header for an empty list, as ws does', async () => {
    const { socket } = fakeSocket()
    const upgrade = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 101, headers: new Headers(), webSocket: socket }) as unknown as Response)
    const ws = new WebSocket('ws://container/artifacts/app/', [], { headers: {}, fetch: upgrade })
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))

    expect(new Headers(upgrade.mock.calls[0][1].headers).has('Sec-WebSocket-Protocol')).toBe(false)
  })
})

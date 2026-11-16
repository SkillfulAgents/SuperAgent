import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it } from 'vitest'
import type { WorkerWebSocket } from 'cloudflare:workers'
import { WebSocket } from './ws'

type Handler = (event: Record<string, unknown>) => void

function fakeSocket() {
  const handlers = new Map<string, Handler>()
  const socket = {
    readyState: 1,
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    send: () => {},
    close: () => {},
  } as unknown as WorkerWebSocket
  return { socket, deliver: (type: string, event: Record<string, unknown>) => handlers.get(type)!(event) }
}

describe('ws shim', () => {
  it('runs listeners in the async context the socket was made in', () => {
    const owner = new AsyncLocalStorage<string>()
    const { socket, deliver } = fakeSocket()
    const ws = owner.run('agent-object', () => WebSocket.fromSocket(socket))
    const seen: Array<string | undefined> = []
    ws.on('message', () => seen.push(owner.getStore()))
    ws.onmessage = () => seen.push(owner.getStore())
    ws.on('close', () => seen.push(owner.getStore()))

    // The runtime delivers events outside any context.
    deliver('message', { data: 'session settled' })
    deliver('close', { code: 1000, reason: '' })

    expect(seen).toEqual(['agent-object', 'agent-object', 'agent-object'])
  })

  it('answers a ping with a pong only while the runtime holds the connection open', async () => {
    const { socket } = fakeSocket()
    const ws = WebSocket.fromSocket(socket)
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
})

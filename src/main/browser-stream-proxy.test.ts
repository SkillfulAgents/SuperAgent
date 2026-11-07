import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * A real client, a real listener running the upgrade handler, and a real upstream WebSocket
 * server standing in for the container: an upgrade never reaches Hono, and what this covers
 * (the role gate, and what happens before upstream opens) only exists on real sockets.
 */

let canInput = true
let upstreamPort = 0

vi.mock('@shared/lib/agent-actor', () => ({
  agentCatalog: { resolve: async (slug: string) => slug },
  agentRegistry: {
    get: () => ({
      container: {
        webSocketTarget: async (path: string, init?: { search?: string }) => ({
          url: `ws://127.0.0.1:${upstreamPort}${path}${init?.search ?? ''}`,
          headers: {},
        }),
        status: async () => ({ status: 'running' }),
      },
    }),
  },
}))
vi.mock('./agent-websocket-auth', () => ({
  authenticateAgentWebSocket: async (_request: unknown, _slug: string, role: string) => role === 'viewer' || canInput,
}))
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: async () => ({ app: {} }) }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import { setupBrowserStreamProxy } from './browser-stream-proxy'

const viewport = (width: number) => JSON.stringify({ type: 'viewport', width })
const mouse = JSON.stringify({ type: 'input_mouse', eventType: 'mouseMoved', x: 1, y: 1 })

describe('browser stream proxy', () => {
  let proxy: Server
  let proxyPort: number
  let upstreamHttp: Server
  let upstream: WebSocketServer
  let upstreamUrls: string[]
  let received: string[]
  /** Handshakes waiting for the test to let them finish, to model a slow container. */
  let heldUpgrades: Array<() => void>
  let holdUpgrades: boolean
  const clients: WebSocket[] = []

  beforeAll(async () => {
    upstream = new WebSocketServer({ noServer: true })
    upstream.on('connection', (socket) => {
      // The log of the test that opened this connection: an earlier test's messages can still be in flight.
      const log = received
      socket.on('message', (data) => log.push(data.toString()))
    })
    upstreamHttp = createServer()
    upstreamHttp.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      upstreamUrls.push(request.url ?? '')
      const finish = () => upstream.handleUpgrade(request, socket, head, (client) => upstream.emit('connection', client, request))
      if (holdUpgrades) heldUpgrades.push(finish)
      else finish()
    })
    await new Promise<void>((resolve) => upstreamHttp.listen(0, '127.0.0.1', resolve))
    upstreamPort = (upstreamHttp.address() as AddressInfo).port

    proxy = createServer()
    setupBrowserStreamProxy(proxy as never)
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    proxyPort = (proxy.address() as AddressInfo).port
  })

  afterAll(async () => {
    clients.forEach((client) => client.terminate())
    upstream.clients.forEach((client) => client.terminate())
    await new Promise((resolve) => proxy.close(resolve))
    await new Promise((resolve) => upstreamHttp.close(resolve))
  })

  beforeEach(() => {
    canInput = true
    upstreamUrls = []
    received = []
    heldUpgrades = []
    holdUpgrades = false
  })

  async function connect(query = '') {
    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/agents/agent-1/browser/stream${query}`)
    clients.push(client)
    await new Promise((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    return client
  }

  it('passes only a numeric width on to the container', async () => {
    await connect('?width=841&secret=abc')
    await vi.waitFor(() => expect(upstreamUrls).toEqual(['/browser/stream?width=841']))

    upstreamUrls = []
    await connect('?width=1e400')
    await vi.waitFor(() => expect(upstreamUrls).toEqual(['/browser/stream']))
  })

  it('forwards input from a client with the user role', async () => {
    const client = await connect()
    await vi.waitFor(() => {
      client.send(mouse)
      expect(received).toContain(mouse)
    })
  })

  it('lets a view-only client size its frames, but not send input', async () => {
    canInput = false
    const client = await connect()
    await vi.waitFor(() => {
      client.send(mouse)
      client.send(viewport(900))
      expect(received).toContain(viewport(900))
    })
    client.send(JSON.stringify({ type: 'navigate', action: 'reload' }))
    client.send(Buffer.from(viewport(901)), { binary: true })
    client.send('not json')
    client.send(JSON.stringify({ type: 'viewport', width: 901, padding: 'x'.repeat(1024) }))
    client.send(viewport(902))
    await vi.waitFor(() => expect(received).toContain(viewport(902)))
    expect(new Set(received)).toEqual(new Set([viewport(900), viewport(902)]))
  })

  it.each([
    ['user', true],
    ['viewer', false],
  ])('delivers the latest width from before upstream opened, without the stale input (%s)', async (_role, role) => {
    canInput = role
    holdUpgrades = true
    const client = await connect()
    client.send(viewport(100))
    client.send(mouse)
    client.send(viewport(200))
    await vi.waitFor(() => expect(heldUpgrades).toHaveLength(1))
    // Round trip the socket so the proxy has read everything above before upstream opens.
    await new Promise<void>((resolve) => client.ping(undefined, undefined, () => resolve()))
    await new Promise((resolve) => client.once('pong', resolve))

    heldUpgrades[0]()
    await vi.waitFor(() => expect(received).toEqual([viewport(200)]))
  })
})

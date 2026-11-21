import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createServer, type Server } from 'node:http'
import { connect as connectTcp, type AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'

let upstreamPort = 0

vi.mock('@shared/lib/agent-actor', () => ({
  agentCatalog: { resolve: async (routeAgentId: string) => routeAgentId },
  agentRegistry: {
    get: () => ({
      container: {
        webSocketTarget: async (path: string) => ({ url: `ws://127.0.0.1:${upstreamPort}${path}`, headers: {} }),
      },
    }),
  },
}))
vi.mock('./agent-websocket-auth', () => ({ authenticateAgentWebSocket: async () => true }))
const captureException = vi.hoisted(() => vi.fn())
vi.mock('@shared/lib/error-reporting', () => ({ captureException }))

import {
  artifactUpstreamOpened,
  artifactWebSocketForwardHeaders,
  parseArtifactWebSocketRoute,
  setupArtifactStreamProxy,
  type AdmittedArtifactStream,
} from './artifact-stream-proxy'

function request(headers: Record<string, string>) {
  return {
    headers,
    socket: Object.assign(new EventEmitter(), {
      encrypted: false,
      remoteAddress: '127.0.0.1',
    }),
  } as any
}

describe('artifact WebSocket route', () => {
  it('maps the public dashboard path to the container proxy path', () => {
    expect(
      parseArtifactWebSocketRoute('/api/agents/agent-1/artifacts/open-slide/__vite_hmr'),
    ).toEqual({
      routeAgentId: 'agent-1',
      artifactSlug: 'open-slide',
      publicBasePath: '/api/agents/agent-1/artifacts/open-slide/',
      containerPath: '/artifacts/open-slide/__vite_hmr',
    })
  })

  it('rejects malformed and invalid artifact paths', () => {
    expect(parseArtifactWebSocketRoute('/api/agents/a/browser/stream')).toBeNull()
    expect(parseArtifactWebSocketRoute('/api/agents/a/artifacts/../hmr')).toBeNull()
    expect(parseArtifactWebSocketRoute('/api/agents/a/artifacts/OpenSlide/hmr')).toBeNull()
  })
})

describe('artifact WebSocket forwarding headers', () => {
  it('adds the mount contract and strips handshake/host-auth internals', () => {
    const result = artifactWebSocketForwardHeaders(
      request({
        host: 'gamut.example',
        origin: 'https://gamut.example',
        cookie: 'dashboard=abc',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'secret',
        'x-superagent-host-token': 'do-not-forward',
      }),
      '/api/agents/a/artifacts/slides/',
    )

    expect(result['x-forwarded-prefix']).toBe('/api/agents/a/artifacts/slides')
    expect(result['x-forwarded-host']).toBe('gamut.example')
    expect(result['x-forwarded-proto']).toBe('https')
    expect(result['x-forwarded-for']).toBe('127.0.0.1')
    expect(result.cookie).toBe('dashboard=abc')
    expect(result).not.toHaveProperty('sec-websocket-key')
    expect(result).not.toHaveProperty('x-superagent-host-token')
  })
})

describe('artifact WebSocket proxy', () => {
  let proxy: Server
  let dashboard: WebSocketServer
  const clients: WebSocket[] = []
  const dashboardSockets: WebSocket[] = []

  beforeAll(async () => {
    dashboard = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    // Like Vite's HMR server, the dashboard speaks first, often in the same read as its handshake.
    dashboard.on('connection', (socket) => {
      dashboardSockets.push(socket)
      socket.send('connected')
    })
    await new Promise((resolve) => dashboard.once('listening', resolve))
    upstreamPort = (dashboard.address() as AddressInfo).port

    proxy = createServer()
    setupArtifactStreamProxy(proxy as never)
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  })

  afterAll(async () => {
    clients.forEach((client) => client.terminate())
    dashboard.clients.forEach((client) => client.terminate())
    await new Promise((resolve) => proxy.close(resolve))
    await new Promise((resolve) => dashboard.close(resolve))
  })

  it('relays the message the dashboard sends as it accepts the socket', async () => {
    const { port } = proxy.address() as AddressInfo
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/agents/agent-1/artifacts/open-slide/__vite_hmr`)
    clients.push(client)
    const first = new Promise<string>((resolve, reject) => {
      client.once('message', (data) => resolve(data.toString()))
      client.once('error', reject)
    })
    await expect(first).resolves.toBe('connected')
  })

  it('closes the dashboard socket when the browser handshake is refused after the dashboard opened', async () => {
    const { port } = proxy.address() as AddressInfo
    const opened = dashboardSockets.length
    // No Sec-WebSocket-Key: ws answers 400 and never hands the socket over.
    const tcp = connectTcp(port, '127.0.0.1')
    tcp.write(
      'GET /api/agents/agent-1/artifacts/open-slide/__vite_hmr HTTP/1.1\r\n'
      + 'Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n',
    )
    const response = await new Promise<string>((resolve) => tcp.once('data', (data) => resolve(data.toString())))
    expect(response).toMatch(/^HTTP\/1\.1 400/)
    await vi.waitFor(() => {
      expect(dashboardSockets).toHaveLength(opened + 1)
      expect(dashboardSockets[opened].readyState).toBe(WebSocket.CLOSED)
    })
    tcp.destroy()
  })
})

describe('artifactUpstreamOpened', () => {
  const admitted = {
    agentSlug: 'agent-1',
    route: parseArtifactWebSocketRoute('/api/agents/agent-1/artifacts/open-slide/__vite_hmr')!,
    target: { url: '', headers: {} },
  } as AdmittedArtifactStream
  let refusing: Server

  beforeAll(async () => {
    // Answers every upgrade with a plain 404, as a dashboard with no socket at that path does.
    refusing = createServer((_req, res) => res.writeHead(404).end())
    refusing.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'))
    await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve))
  })

  afterAll(async () => {
    await new Promise((resolve) => refusing.close(resolve))
  })

  it('resolves false and reports when the dashboard refuses the upgrade', async () => {
    captureException.mockClear()
    const onOpen = vi.fn()
    const upstream = new WebSocket(`ws://127.0.0.1:${(refusing.address() as AddressInfo).port}/hmr`)
    await expect(artifactUpstreamOpened(upstream, admitted, onOpen)).resolves.toBe(false)
    expect(onOpen).not.toHaveBeenCalled()
    expect(captureException).toHaveBeenCalledOnce()
  })

  it('resolves false and reports when the dashboard socket errors', async () => {
    captureException.mockClear()
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const { port } = closed.address() as AddressInfo
    await new Promise((resolve) => closed.close(resolve))
    const onOpen = vi.fn()
    await expect(artifactUpstreamOpened(new WebSocket(`ws://127.0.0.1:${port}/hmr`), admitted, onOpen)).resolves.toBe(false)
    expect(onOpen).not.toHaveBeenCalled()
    expect(captureException).toHaveBeenCalledOnce()
  })

  it('resolves false with no report when the browser goes away while it connects', async () => {
    captureException.mockClear()
    const hanging = createServer()
    hanging.on('upgrade', () => {})
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve))
    const browserGone = new AbortController()
    const onOpen = vi.fn()
    const upstream = new WebSocket(`ws://127.0.0.1:${(hanging.address() as AddressInfo).port}/hmr`)
    const opened = artifactUpstreamOpened(upstream, admitted, onOpen, browserGone.signal)
    browserGone.abort()
    await expect(opened).resolves.toBe(false)
    await vi.waitFor(() => expect(upstream.readyState).toBe(WebSocket.CLOSED))
    expect(onOpen).not.toHaveBeenCalled()
    expect(captureException).not.toHaveBeenCalled()
    hanging.closeAllConnections()
    await new Promise((resolve) => hanging.close(resolve))
  })
})

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import {
  artifactWebSocketForwardHeaders,
  parseArtifactWebSocketRoute,
  setupArtifactStreamProxy,
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

  beforeAll(async () => {
    dashboard = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    // Like Vite's HMR server, the dashboard speaks first, often in the same read as its handshake.
    dashboard.on('connection', (socket) => socket.send('connected'))
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
})

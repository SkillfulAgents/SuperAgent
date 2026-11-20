import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  resolve: vi.fn(async (slug: string): Promise<string | null> => slug),
  webSocketTarget: vi.fn(async (): Promise<{ url: string; protocols?: string[]; headers: Record<string, string> } | null> => ({
    url: 'ws://agent-container.internal/sales-agent/artifacts/sales-board/',
    protocols: ['vite-hmr'],
    headers: { authorization: 'Bearer host-token' },
  })),
  /** The upgrade request, as the container runner's reach answers it. */
  reach: vi.fn(),
  /** The roles the signed-in user holds on the agent. */
  roles: new Set<string>(),
}))
vi.mock('@shared/lib/agent-actor', () => ({
  agentCatalog: { resolve: deps.resolve },
  agentRegistry: { get: () => ({ container: { webSocketTarget: deps.webSocketTarget } }) },
}))
vi.mock('../cloudflare-container-control', () => ({ agentContainers: () => ({ fetch: deps.reach }) }))
vi.mock('../../main/agent-websocket-auth', () => ({
  authenticateAgentWebSocket: async (_request: unknown, _slug: string, role: string) => deps.roles.has(role),
}))

import { serveArtifactStream } from './artifact-stream'
import type { Env } from '../index'

const ENV = { AGENT: {} } as unknown as Env

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void

function socket() {
  const listeners = new Map<string, Listener[]>()
  const sent: unknown[] = []
  const closed: Array<[number | undefined, string | undefined]> = []
  const emit = (type: string, event: Parameters<Listener>[0]) => (listeners.get(type) ?? []).forEach((listener) => listener(event))
  return {
    sent,
    closed,
    accept: () => {},
    close: (code?: number, reason?: string) => closed.push([code, reason]),
    send: (data: unknown) => sent.push(data),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    deliver: (data: unknown) => emit('message', { data }),
    closeFromPeer: (code: number, reason: string) => emit('close', { code, reason }),
  }
}

const upgrade = (path = '/api/agents/sales-agent/artifacts/sales-board/', search = '') =>
  new Request(`https://org.example.com${path}${search}`, { headers: { Upgrade: 'websocket', cookie: 'session=abc', 'Sec-WebSocket-Protocol': 'vite-hmr', 'x-forwarded-for': '203.0.113.7' } })

describe('serveArtifactStream', () => {
  let upstream: ReturnType<typeof socket>
  let server: ReturnType<typeof socket>
  const NodeResponse = globalThis.Response

  beforeEach(() => {
    upstream = socket()
    server = socket()
    deps.roles.clear()
    deps.webSocketTarget.mockClear()
    deps.reach.mockReset().mockImplementation(async () => ({ webSocket: upstream, headers: new Headers({ 'Sec-WebSocket-Protocol': 'vite-hmr' }) }))
    vi.stubGlobal('WebSocketPair', class {
      0 = socket()
      1 = server
    })
  })

  afterEach(() => {
    vi.stubGlobal('Response', NodeResponse)
  })

  /** Opens the socket; Node's Response refuses the 101 answer with a socket, so that one is a plain object here. */
  async function open(path?: string, search?: string) {
    vi.stubGlobal('Response', class {
      constructor(_body: unknown, readonly init: { status: number; headers?: Record<string, string> }) {}
    })
    return (await serveArtifactStream(upgrade(path, search), ENV)) as unknown as { init: { status: number; headers?: Record<string, string> } }
  }

  it('refuses someone who may not view the agent, before it reaches the container', async () => {
    const response = await serveArtifactStream(upgrade(), ENV)

    expect(response.status).toBe(403)
    expect(deps.webSocketTarget).not.toHaveBeenCalled()
  })

  it("opens the dashboard's socket in the container under its public path, with the protocol it picked", async () => {
    deps.roles.add('viewer')
    const response = await open('/api/agents/sales-agent/artifacts/sales-board/', '?token=hmr-1')

    expect(response.init.status).toBe(101)
    expect(response.init.headers).toEqual({ 'Sec-WebSocket-Protocol': 'vite-hmr' })
    expect(deps.webSocketTarget).toHaveBeenCalledWith('/artifacts/sales-board/', expect.objectContaining({
      search: '?token=hmr-1',
      protocols: ['vite-hmr'],
      headers: expect.objectContaining({
        'x-forwarded-prefix': '/api/agents/sales-agent/artifacts/sales-board',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.7',
      }),
    }))
    expect(deps.reach).toHaveBeenCalledWith('http://agent-container.internal/sales-agent/artifacts/sales-board/', {
      headers: { authorization: 'Bearer host-token', Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'vite-hmr' },
    })
  })

  it('passes messages both ways, and closes the browser side with the code the dashboard closed with', async () => {
    deps.roles.add('viewer')
    await open()

    server.deliver('{"type":"ping"}')
    upstream.deliver('{"type":"full-reload"}')
    await vi.waitFor(() => expect(upstream.sent).toEqual(['{"type":"ping"}']))
    await vi.waitFor(() => expect(server.sent).toEqual(['{"type":"full-reload"}']))

    upstream.closeFromPeer(4001, 'server restarted')
    expect(server.closed).toEqual([[4001, 'server restarted']])
  })

  it('answers 404 for a path that is not a dashboard', async () => {
    deps.roles.add('viewer')
    const response = await serveArtifactStream(upgrade('/api/agents/sales-agent/artifacts/Not_A_Slug/'), ENV)

    expect(response.status).toBe(404)
  })
})

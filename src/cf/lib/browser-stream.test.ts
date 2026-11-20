import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  resolve: vi.fn(async (slug: string): Promise<string | null> => slug),
  webSocketTarget: vi.fn(async (): Promise<{ url: string; headers: Record<string, string> } | null> => ({ url: 'ws://agent-container.internal/sales-agent/browser/stream', headers: { authorization: 'Bearer host-token' } })),
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

import { serveBrowserStream } from './browser-stream'
import type { Env } from '../index'

const ENV = { AGENT: {} } as unknown as Env

type Listener = (event: { data?: unknown }) => void

function socket() {
  const listeners = new Map<string, Listener>()
  const sent: unknown[] = []
  return {
    sent,
    accept: () => {},
    close: () => {},
    send: (data: unknown) => sent.push(data),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    deliver: (data: unknown) => listeners.get('message')!({ data }),
  }
}

const upgrade = (search = '') => new Request(`https://org.example.com/api/agents/sales-agent/browser/stream${search}`, { headers: { Upgrade: 'websocket', cookie: 'session=abc' } })

describe('serveBrowserStream', () => {
  let upstream: ReturnType<typeof socket>
  let server: ReturnType<typeof socket>
  const NodeResponse = globalThis.Response

  beforeEach(() => {
    upstream = socket()
    server = socket()
    deps.roles.clear()
    deps.webSocketTarget.mockClear()
    deps.reach.mockReset().mockImplementation(async () => ({ webSocket: upstream }))
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('the global fetch was called')
    }))
    vi.stubGlobal('WebSocketPair', class {
      0 = socket()
      1 = server
    })
  })

  afterEach(() => {
    vi.stubGlobal('Response', NodeResponse)
  })

  /** Opens the stream; Node's Response refuses the 101 answer with a socket, so that one is a plain object here. */
  async function open(search = '') {
    vi.stubGlobal('Response', class {
      constructor(_body: unknown, readonly init: { status: number }) {}
    })
    const response = (await serveBrowserStream(upgrade(search), 'sales-agent', ENV)) as unknown as { init: { status: number } }
    expect(response.init.status).toBe(101)
  }

  it('refuses someone who may not view the agent, before it reaches the container', async () => {
    const response = await serveBrowserStream(upgrade(), 'sales-agent', ENV)

    expect(response.status).toBe(403)
    expect(deps.webSocketTarget).not.toHaveBeenCalled()
  })

  it("forwards the container's frames as bytes, and passes only the canvas width on to it", async () => {
    deps.roles.add('viewer')
    await open('?width=1280&token=abc')

    expect(deps.webSocketTarget).toHaveBeenCalledWith('/browser/stream', { search: '?width=1280' })
    upstream.deliver(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]))
    await vi.waitFor(() => expect(server.sent).toHaveLength(1))
    expect([...new Uint8Array(server.sent[0] as ArrayBuffer)]).toEqual([0xff, 0xd8, 0xff])
  })

  it("lets a viewer size the frames but not steer the agent's browser", async () => {
    deps.roles.add('viewer')
    await open()

    server.deliver('{"type":"click","x":10,"y":20}')
    server.deliver('{"type":"viewport","width":1280}')
    await vi.waitFor(() => expect(upstream.sent).toHaveLength(1))

    expect(upstream.sent).toEqual(['{"type":"viewport","width":1280}'])
  })

  it('sends the input of someone who may use the agent', async () => {
    deps.roles.add('viewer').add('user')
    await open()

    server.deliver('{"type":"click","x":10,"y":20}')
    await vi.waitFor(() => expect(upstream.sent).toHaveLength(1))

    expect(upstream.sent).toEqual(['{"type":"click","x":10,"y":20}'])
  })
})

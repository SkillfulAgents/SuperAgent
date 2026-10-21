import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({ getContainerEnvVars: () => ({}) }),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ app: {}, container: { containerRunner: 'cloudflare-container' } }),
}))

import { CONTAINER_INTERNAL_PORT } from './base-container-client'
import {
  CloudflareContainerRuntimeClient,
  HOST_INTERNAL_ORIGIN,
  setAgentContainerNamespace,
  type AgentContainerStub,
} from './cloudflare-container-runtime'

/** One agent's container Durable Object, as the Worker binding exposes it. */
class FakeContainer implements AgentContainerStub {
  running = false
  startedWith: Record<string, string> | null = null
  requests: Request[] = []
  socket: FakeSocket | null = null

  async startAgent(envVars: Record<string, string>) {
    this.startedWith = envVars
    this.running = true
  }
  async stopAgent() {
    this.running = false
  }
  async agentRunning() {
    return this.running
  }
  async fetch(request: Request): Promise<Response> {
    this.requests.push(request)
    if (request.headers.get('Upgrade') === 'websocket') {
      if (!this.socket) return new Response(null, { status: 503 })
      return Object.assign(new Response(null, { status: 200 }), { webSocket: this.socket })
    }
    if (!this.running) return new Response('container not running', { status: 503 })
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
  }
}

/** The Workers WebSocket the container's stub hands back on an accepted upgrade. */
class FakeSocket extends EventTarget {
  readyState = 0
  accepted = false
  sent: unknown[] = []
  closedWith: number | null = null
  accept() {
    this.accepted = true
    this.readyState = 1
  }
  send(data: unknown) {
    this.sent.push(data)
  }
  close(code?: number) {
    this.closedWith = code ?? 1000
    this.readyState = 3
  }
  receive(data: string) {
    this.dispatchEvent(Object.assign(new Event('message'), { data }))
  }
  remoteClose(code: number, reason: string) {
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }))
  }
}

const containers = new Map<string, FakeContainer>()
function containerFor(agentId: string): FakeContainer {
  let container = containers.get(agentId)
  if (!container) {
    container = new FakeContainer()
    containers.set(agentId, container)
  }
  return container
}

setAgentContainerNamespace({
  idFromName: (name) => name,
  get: (id) => containerFor(id as string),
})

function client(agentId = 'research-agent') {
  return new CloudflareContainerRuntimeClient({ agentId })
}

beforeEach(() => {
  containers.clear()
})

describe('CloudflareContainerRuntimeClient lifecycle', () => {
  it('starts the agent container with the agent env and waits for /health through the stub', async () => {
    const c = client()

    const info = await c.start({ envVars: { CUSTOM_FLAG: 'on' }, agentName: 'Research Agent' })

    expect(info).toEqual({ status: 'running', port: CONTAINER_INTERNAL_PORT })
    const container = containerFor('research-agent')
    expect(container.startedWith).toMatchObject({
      CUSTOM_FLAG: 'on',
      SUPERAGENT_AGENT_ID: 'research-agent',
      SUPERAGENT_AGENT_NAME: 'Research Agent',
      CLAUDE_CONFIG_DIR: '/workspace/.claude',
    })
    expect(container.requests.map((r) => new URL(r.url).pathname)).toContain('/health')
  })

  it('sends volumes as SUPERAGENT_VOLUMES', async () => {
    const volumes = [{ volumeId: 'vol_team', name: 'team-drive', volumeName: 'Team Drive' }]

    await client().start({ volumes })

    expect(JSON.parse(containerFor('research-agent').startedWith!.SUPERAGENT_VOLUMES)).toEqual(volumes)
  })

  it('does not restart a running container and reports it as already running', async () => {
    containerFor('research-agent').running = true
    const onAlreadyRunning = vi.fn()

    const info = await client().start({ onAlreadyRunning })

    expect(info).toEqual({ status: 'running', port: CONTAINER_INTERNAL_PORT })
    expect(onAlreadyRunning).toHaveBeenCalledTimes(1)
    expect(containerFor('research-agent').startedWith).toBeNull()
  })

  it('maps the container state to running or stopped', async () => {
    const c = client()
    expect(await c.getInfoFromRuntime()).toEqual({ status: 'stopped', port: null })

    containerFor('research-agent').running = true
    expect(await c.getInfoFromRuntime()).toEqual({ status: 'running', port: CONTAINER_INTERNAL_PORT })
  })

  it('stops the container', async () => {
    const c = client()
    await c.start()

    expect(await c.stop()).toEqual({ forceStopUsed: false, stopped: true })
    expect(containerFor('research-agent').running).toBe(false)
    expect(await c.getInfoFromRuntime()).toEqual({ status: 'stopped', port: null })
  })

  it('keeps each agent on its own container', async () => {
    await client('research-agent').start()

    expect(containerFor('research-agent').running).toBe(true)
    expect(containerFor('inbox-agent').running).toBe(false)
  })

  it('points the agent at the host through the container outbound route', () => {
    expect(client().getHostApiBaseUrl()).toBe(HOST_INTERNAL_ORIGIN)
  })
})

describe('CloudflareContainerRuntimeClient requests', () => {
  it('sends container API calls through the stub with the host auth headers', async () => {
    const c = client()
    await c.start()
    const container = containerFor('research-agent')
    container.requests = []

    const response = await c.fetch('/sessions')

    expect(response.status).toBe(200)
    expect(container.requests).toHaveLength(1)
    expect(new URL(container.requests[0].url).pathname).toBe('/sessions')
    for (const [name, value] of Object.entries(c.getHostAuthHeaders())) {
      expect(container.requests[0].headers.get(name)).toBe(value)
    }
  })
})

describe('CloudflareContainerRuntimeClient WebSocket', () => {
  it('upgrades through the stub and relays frames both ways', async () => {
    const container = containerFor('research-agent')
    container.socket = new FakeSocket()
    const ws = client().openWebSocket('ws://127.0.0.1:3000/sessions/s1/stream', { 'X-Host-Token': 'abc' }, 'gamut.v1')
    const opened = new Promise<void>((resolve) => ws.on('open', () => resolve()))
    const messages: string[] = []
    ws.on('message', (data) => messages.push(data.toString()))

    await opened
    const upgrade = container.requests[0]
    expect(upgrade.url).toBe('http://127.0.0.1:3000/sessions/s1/stream')
    expect(upgrade.headers.get('Upgrade')).toBe('websocket')
    expect(upgrade.headers.get('X-Host-Token')).toBe('abc')
    expect(upgrade.headers.get('Sec-WebSocket-Protocol')).toBe('gamut.v1')
    expect(container.socket.accepted).toBe(true)
    expect(ws.readyState).toBe(1)

    container.socket.receive('{"type":"status"}')
    ws.send('{"type":"ping"}')
    expect(messages).toEqual(['{"type":"status"}'])
    expect(container.socket.sent).toEqual(['{"type":"ping"}'])
  })

  it('reports the remote close code', async () => {
    const container = containerFor('research-agent')
    container.socket = new FakeSocket()
    const ws = client().openWebSocket('ws://127.0.0.1:3000/sessions/s1/stream', {})
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    const closed = new Promise<[number, string]>((resolve) => ws.on('close', (code, reason) => resolve([code, reason.toString()])))

    container.socket.remoteClose(1011, 'agent restarted')

    expect(await closed).toEqual([1011, 'agent restarted'])
  })

  it('emits error then close when the upgrade is refused', async () => {
    const ws = client().openWebSocket('ws://127.0.0.1:3000/sessions/s1/stream', {})
    const events: string[] = []
    ws.on('error', (error) => events.push(`error: ${error.message}`))
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))

    expect(await closed).toBe(1006)
    expect(events).toEqual(['error: WebSocket upgrade refused with status 503'])
  })

  it('closes a socket that opens after the caller already closed it', async () => {
    const container = containerFor('research-agent')
    const socket = new FakeSocket()
    container.socket = socket
    const ws = client().openWebSocket('ws://127.0.0.1:3000/sessions/s1/stream', {})
    const opened = vi.fn()
    ws.on('open', opened)

    ws.close()
    await vi.waitFor(() => expect(socket.closedWith).toBe(1000))
    expect(opened).not.toHaveBeenCalled()
  })
})

/**
 * BaseContainerClient.warmSession against real HTTP servers: a current agent
 * container (with POST /sessions/:id/warm) and an image from before it, whose
 * router answers the plain-text 404 every Hono app gives an unknown route.
 * The host fires this from POST /api/agents/:id/start, so it must never throw
 * and must read every failure as "nothing warmed".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import type { ContainerConfig, ContainerInfo } from './types'
import { BaseContainerClient } from './base-container-client'

vi.mock('@shared/lib/container/host-token-store', () => ({ getOrCreateHostToken: () => 'test-host-token' }))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: () => ({ enableToolSearch: true }) }))
vi.mock('@shared/lib/llm-provider', () => ({ getActiveLlmProvider: () => ({ getContainerEnvVars: () => ({}) }) }))

class PortClient extends BaseContainerClient {
  constructor(private readonly info: ContainerInfo) {
    super({ agentId: 'test-agent' } as ContainerConfig)
  }
  protected getRunnerCommand(): string { return 'docker' }
  async getInfoFromRuntime(): Promise<ContainerInfo> { return this.info }
}

const servers: ServerType[] = []

async function listen(app: Hono): Promise<number> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => resolve(info.port))
    servers.push(server)
  })
}

/** The session routes every container image has had. */
function olderContainerApp(): Hono {
  const app = new Hono()
  app.get('/health', (c) => c.json({ status: 'ok' }))
  app.post('/sessions/:id/messages', (c) => c.json({ success: true }, 201))
  return app
}

function currentContainerApp(known: Set<string>, seen: Array<{ id: string; token?: string }>): Hono {
  const app = olderContainerApp()
  app.post('/sessions/:id/warm', (c) => {
    seen.push({ id: c.req.param('id'), token: c.req.header('x-superagent-host-token') })
    if (!known.has(c.req.param('id'))) return c.json({ error: 'Session not found' }, 404)
    return c.json({ accepted: true }, 202)
  })
  return app
}

describe('BaseContainerClient.warmSession', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  })

  it('asks a current container to pre-resume the session, as the host', async () => {
    const seen: Array<{ id: string; token?: string }> = []
    const port = await listen(currentContainerApp(new Set(['session-1']), seen))
    const client = new PortClient({ status: 'running', port })

    await expect(client.warmSession('session-1')).resolves.toBe(true)
    expect(seen).toEqual([{ id: 'session-1', token: 'test-host-token' }])
  })

  it('reads an unknown session (JSON 404) as nothing warmed', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const port = await listen(currentContainerApp(new Set(), []))
    const client = new PortClient({ status: 'running', port })

    await expect(client.warmSession('gone')).resolves.toBe(false)
    expect(debug).toHaveBeenCalledWith('[ContainerClient] warmSession: container returned 404')
  })

  it('swallows the plain 404 of a container image that predates the endpoint', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')
    const port = await listen(olderContainerApp())
    const client = new PortClient({ status: 'running', port })

    await expect(client.warmSession('session-1')).resolves.toBe(false)
    expect(debug).toHaveBeenCalledWith('[ContainerClient] warmSession: the agent container predates the warm endpoint')
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('sends the session id as one path segment, whatever it contains', async () => {
    const seen: Array<{ id: string; token?: string }> = []
    const port = await listen(currentContainerApp(new Set(['a b?c']), seen))
    const client = new PortClient({ status: 'running', port })

    await expect(client.warmSession('a b?c')).resolves.toBe(true)
    expect(seen.map((s) => s.id)).toEqual(['a b?c'])
  })

  it('never throws when the container is not running', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const client = new PortClient({ status: 'stopped', port: null })

    await expect(client.warmSession('session-1')).resolves.toBe(false)
  })

  it('never throws when the request times out or the connection fails', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const client = new PortClient({ status: 'running', port: 1 })
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(timeout)

    await expect(client.warmSession('session-1')).resolves.toBe(false)
    // The request is bounded: it carries an abort signal.
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.signal).toBeInstanceOf(AbortSignal)

    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    await expect(client.warmSession('session-1')).resolves.toBe(false)
  })
})

/**
 * The MCP proxy's own sessions (the ones it answers `initialize` for while a
 * server needs re-authentication) are the agent's: their upstream binding is
 * read where it is used, so a request that waited for authorization while
 * another request reconnected goes out on the new upstream session, not the
 * one it saw on arrival.
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { AgentLocks } from '@shared/lib/agent-actor/agent-locks'
import { AgentMcpSessions } from '@shared/lib/mcp/agent-mcp-sessions'

const mock = vi.hoisted(() => ({ actor: undefined as unknown, connection: undefined as unknown as Record<string, any>, fetch: vi.fn() }))
vi.mock('@shared/lib/agent-actor', () => ({ agentRegistry: { get: () => mock.actor } }))
vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: async () => 'agent' }))
vi.mock('@shared/lib/db', () => ({ db: { insert: () => ({ values: async () => {} }) } }))
vi.mock('@shared/lib/mcp/connections', () => ({ resolveMcpConnection: async () => ({ ok: true, connection: mock.connection }) }))
vi.mock('@shared/lib/mcp/mcp-safe-fetch', () => ({ mcpSafeFetch: (...args: unknown[]) => mock.fetch(...args) }))

import mcpProxy from './mcp-proxy'

beforeEach(() => {
  const locks = new AgentLocks()
  const sessions = new AgentMcpSessions()
  mock.actor = {
    locks: { acquire: (key: string) => locks.acquire(key), release: async (key: string, token: string) => locks.release(key, token) },
    mcpSessions: {
      open: async (mcpId: string, protocolVersion: string) => sessions.open(mcpId, protocolVersion),
      get: async (mcpId: string, id: string) => sessions.get(mcpId, id),
      bind: async (id: string, upstream: string | null) => sessions.bind(id, upstream),
      unbind: async (id: string, upstream: string | null) => sessions.unbind(id, upstream),
      close: async (id: string) => sessions.close(id),
    },
  }
  mock.connection = {
    descriptor: { id: 'mcp', name: 'Example', url: 'https://mcp.example.com', status: 'auth_required', tools: [] },
    authorizeInvocation: vi.fn(async () => ({ ok: true, policyDecision: 'allow' })),
    authorization: vi.fn(async () => ({ ok: true, accessToken: 'fresh' })),
    recoverAuthorization: vi.fn(async () => ({ ok: true })),
    markAuthRequired: vi.fn(async () => {}),
    reportHealth: vi.fn(async () => {}),
  }
  mock.fetch.mockReset()
})

it('uses the current upstream binding when another request reconnects during authorization', async () => {
  const app = new Hono().route('/mcp', mcpProxy)
  const post = (method: string, sessionId?: string) => app.request('/mcp/agent/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: method === 'tools/call' ? { name: 'example' } : { protocolVersion: '2025-03-26' } }),
  })
  // Opened while the server needed re-authentication: the proxy's own session.
  const initialized = await post('initialize')
  const id = initialized.headers.get('Mcp-Session-Id')!
  mock.connection.descriptor.status = 'active'

  // A stateful upstream: one live session at a time, the latest initialize's.
  let activeUpstream = ''
  let generation = 0
  let expire = false
  const sent: string[] = []
  mock.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as ArrayBuffer))
    if (body.method === 'initialize') {
      activeUpstream = `upstream-${++generation}`
      return Response.json({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'Mcp-Session-Id': activeUpstream } })
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const upstream = new Headers(init.headers).get('Mcp-Session-Id')!
    sent.push(upstream)
    if (expire && generation === 1) return new Response(null, { status: 401 })
    return Response.json({ result: {} }, { status: upstream === activeUpstream ? 200 : 404 })
  })
  expect((await post('tools/call', id)).status).toBe(200)

  // One request waits in authorization while another finds the upstream
  // session dead (401), reconnects, and binds a new one.
  let authorize!: () => void
  let entered!: () => void
  const insideAuthorization = new Promise<void>((resolve) => { entered = resolve })
  const blocked = new Promise<void>((resolve) => { authorize = resolve })
  mock.connection.authorization.mockImplementationOnce(async () => {
    entered()
    await blocked
    return { ok: true, accessToken: 'fresh' }
  })
  const delayed = post('tools/call', id)
  await insideAuthorization
  expire = true
  expect((await post('tools/call', id)).status).toBe(200)
  expect(activeUpstream).toBe('upstream-2')

  authorize()
  expect((await delayed).status).toBe(200)
  // The waiting request went out on the session bound while it waited.
  expect(sent).toEqual(['upstream-1', 'upstream-1', 'upstream-2', 'upstream-2'])
})

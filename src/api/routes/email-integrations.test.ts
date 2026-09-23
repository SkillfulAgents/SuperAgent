import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { getAgentIntegration, listAgentIntegrations } from '@shared/lib/services/agent-integration-service'
let testDb: AppDatabase, handle: TestDatabase
const state = vi.hoisted(() => ({ connected: true, role: 'owner', send: vi.fn(), calls: [] as { url: string; body: Record<string, unknown> | null; method: string; key: string | null }[] }))
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({ getPlatformAccessToken: () => state.connected ? 'platform-test-token' : null }))
vi.mock('@shared/lib/platform-attribution', () => ({ attribution: { requiresActingMember: () => false, fromUserId: async () => ({ bearerToken: () => 'platform-test-token' }) } }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: { addIntegration: vi.fn(), removeIntegration: vi.fn(), pauseIntegration: vi.fn(), resumeIntegration: vi.fn(), reconcileAccess: vi.fn(), integrationCreated: vi.fn(), getConnector: () => ({ getTools: () => [{ name: 'send_email', execute: state.send }] }), ensureSession: vi.fn(async () => { throw new Error('No active session') }) } }))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => 'owner-1' }))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (c: any, next: () => Promise<void>) => { c.set('user', { id: 'owner-1' }); await next() },
  hasMinRole: (actual: string, required: string) => actual === 'owner' || required === 'user',
  AgentRead: () => async (_c: any, next: () => Promise<void>) => next(),
  AgentAdmin: () => async (c: any, next: () => Promise<void>) => state.role === 'owner' ? next() : c.json({ error: 'Forbidden' }, 403),
  AgentUser: () => async (_c: any, next: () => Promise<void>) => next(),
  ResolveAgent: () => async (_c: any, next: () => Promise<void>) => next(),
  getAgentId: (c: any) => c.req.param('id'), getAuthorizedAgentRole: () => state.role,
  EntityAgentRole: (options: any) => (role: string) => async (c: any, next: () => Promise<void>) => {
    if (role === 'owner' && state.role !== 'owner') return c.json({ error: 'Forbidden' }, 403)
    const integration = await options.lookupFn(c.req.param(options.paramName))
    if (!integration) return c.json({ error: 'Not found' }, 404)
    c.set(options.contextKey, integration); await next()
  },
}))
vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: async () => 'agent-a' }))
import xAgentChat from './x-agent-chat'
import router from './agent-integrations'
const app = new Hono().route('/api/chat-integrations', router).route('/api/x-agent/chat', xAgentChat)
const config = { localPart: 'assistant', displayName: 'First Last' }
const mailbox = { id: '00000000-0000-4000-8000-000000000001', address: 'assistant@company.ongamut.so', name: 'First Last', status: 'active' }
const request = (path: string, method: string, body?: unknown) => app.request(`/api/chat-integrations/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
beforeEach(async () => {
  handle = await createTestDatabase(); testDb = handle.db; state.connected = true; state.role = 'owner'; state.calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const path = new URL(url).pathname
    const body = init.body ? JSON.parse(init.body) : null
    state.calls.push({ url, body, method: init.method ?? 'GET', key: new Headers(init.headers).get('Idempotency-Key') })
    if (path.endsWith('/me')) return Response.json({ orgId: 'org-1', memberId: 'member-1' })
    return Response.json({ ...mailbox, ...body })
  }))
})
afterEach(async () => { vi.unstubAllGlobals(); await handle.close() })
it('provisions an owner inbox with the default policy and no client-provided identity', async () => {
  const response = await request('agent-a', 'POST', { provider: 'platform-email', config })
  expect(response.status).toBe(201)
  const body = await response.json()
  expect(body.settings).toMatchObject({ address: mailbox.address, accessLevel: 'agent-users-and-replies' })
  expect(body).not.toHaveProperty('config')
  expect(state.calls[1].body).toEqual({ localPart: 'assistant', name: 'First Last' })
  expect(state.calls[1].key).toHaveLength(64)
  expect(JSON.stringify(body)).not.toContain('platform-test-token')
})
it('rejects creation on disconnected deployments and by non-owners', async () => {
  state.connected = false
  expect((await request('agent-a', 'POST', { provider: 'platform-email', config })).status).toBe(400)
  expect(state.calls).toHaveLength(0)
  state.connected = true; state.role = 'user'
  expect((await request('agent-a', 'POST', { provider: 'platform-email', config })).status).toBe(403)
  expect(await listAgentIntegrations()).toHaveLength(0)
})
it('never lets a client adopt another inbox or choose a credential destination', async () => {
  for (const extra of [{ mailboxId: mailbox.id }, { gatewayUrl: 'https://attacker.test' }, { platformMemberId: 'other' }]) {
    expect((await request('agent-a', 'POST', { provider: 'platform-email', config: { ...config, ...extra } })).status).toBe(400)
  }
  expect(state.calls).toHaveLength(0)
})
it('rejects duplicate inbox bindings across agents', async () => {
  expect((await request('agent-a', 'POST', { provider: 'platform-email', config })).status).toBe(201)
  expect((await request('agent-b', 'POST', { provider: 'platform-email', config })).status).toBe(409)
  expect(await listAgentIntegrations()).toHaveLength(1)
})
it('keeps the address fixed across renames and protects policy changes', async () => {
  const created = await (await request('agent-a', 'POST', { provider: 'platform-email', config })).json()
  state.role = 'user'
  expect((await request(created.id, 'PATCH', { config: { accessLevel: 'anyone' } })).status).toBe(403)
  state.role = 'owner'
  expect((await request(created.id, 'PATCH', { config: { mailboxId: 'another-inbox' } })).status).toBe(400)
  expect((await request(created.id, 'PATCH', { name: 'Renamed Agent' })).status).toBe(200)
  const stored = JSON.parse((await getAgentIntegration(created.id))!.config)
  expect(stored).toMatchObject({ mailboxId: mailbox.id, address: mailbox.address, displayName: 'Renamed Agent' })
  expect(state.calls.at(-1)?.body).toEqual({ name: 'Renamed Agent' })
})
it('disables the gateway mailbox before deleting its local binding', async () => {
  const created = await (await request('agent-a', 'POST', { provider: 'platform-email', config })).json()
  expect((await request(created.id, 'DELETE')).status).toBe(204)
  expect(state.calls.at(-1)?.body).toEqual({ status: 'disabled' })
  expect(await getAgentIntegration(created.id)).toBeNull()
})

const sendRequest = (body: unknown) => app.request('/api/x-agent/chat/send', {
  method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
it('rejects outdated email tool calls with actionable instructions before sending', async () => {
  state.send.mockClear()
  const created = await (await request('agent-a', 'POST', { provider: 'platform-email', config })).json()
  for (const target of [{}, { user_id: 'owner@example.com' }, { chat_id: 'owner@example.com' }]) {
    const response = await sendRequest({ integration_id: created.id, message: 'Hello', ...target })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('Email requires the email object')
  }
  const invalid = await sendRequest({ integration_id: created.id, message: 'Hello', email: { to: ['owner@example.com'] } })
  expect(invalid.status).toBe(400)
  expect((await invalid.json()).error).toContain('idempotency_key')
  expect(state.send).not.toHaveBeenCalled()
})
it('sends the structured email tool payload with no prior conversation and preserves its retry identity', async () => {
  state.send.mockReset().mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000002', mailboxId: mailbox.id, threadId: 'new-thread', direction: 'outbound',
    messageId: null, replyToMessageId: null, from: mailbox.address, to: ['owner@example.com'], cc: [], bcc: [], replyTo: [],
    subject: 'Hello, world!', text: 'Hello, world!', html: null, status: 'queued', createdAt: 1,
  })
  const created = await (await request('agent-a', 'POST', { provider: 'platform-email', config })).json()
  const input = { integration_id: created.id, message: 'Hello, world!', email: { to: ['owner@example.com'], subject: 'Hello, world!', idempotency_key: 'hello-regression-1' } }
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await sendRequest(input)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ chatId: 'new-thread', status: 'queued' })
  }
  expect(state.send).toHaveBeenCalledTimes(2)
  expect(state.send.mock.calls[0][0]).toMatchObject({ to: ['owner@example.com'], subject: 'Hello, world!', text: 'Hello, world!', idempotencyKey: 'hello-regression-1' })
  expect(state.send.mock.calls[1][0]).toEqual(state.send.mock.calls[0][0])
})

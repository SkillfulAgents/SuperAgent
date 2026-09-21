import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
let handle: TestDatabase
let testDb: AppDatabase
let owner = true
const pending = new Map<string, string>()
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
const runtime = vi.hoisted(() => ({ add: vi.fn(async (_id: string) => {}), pause: vi.fn(async (_id: string) => {}) }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: {
  addIntegration: runtime.add, pauseIntegration: runtime.pause, integrationCreated: vi.fn(), isIntegrationConnected: () => false,
} }))
vi.mock('../middleware/auth', () => ({
  getAuthorizedAgentRole: () => owner ? 'owner' : 'user',
  hasMinRole: (role: string, minimum: string) => ({ viewer: 0, user: 1, owner: 2 }[role]! >= { viewer: 0, user: 1, owner: 2 }[minimum]!),
  Authenticated: () => async (c: any, next: () => Promise<void>) => c.req.header('Authorization') ? next() : c.json({ error: 'Unauthorized' }, 401),
  AgentRead: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentUser: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentAdmin: () => async (c: any, next: () => Promise<void>) => owner ? next() : c.json({ error: 'Owner required' }, 403),
  ResolveAgent: () => async (_c: unknown, next: () => Promise<void>) => next(), getAgentId: () => 'agent',
  EntityAgentRole: (options: { lookupFn: (id: string) => Promise<unknown>; contextKey: string }) => (role: string) => async (c: any, next: () => Promise<void>) => {
    if (role === 'owner' && !owner) return c.json({ error: 'Owner required' }, 403)
    const row = await options.lookupFn(c.req.param('integrationId'))
    if (!row) return c.json({ error: 'Not found' }, 404)
    c.set(options.contextKey, row); await next()
  },
}))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => 'owner' }))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn(async () => {}) }))
import { agentIntegrationRegistry } from '@shared/lib/agent-integrations/registry'
import { IntegrationSetupError } from '@shared/lib/agent-integrations/setup-types'
import { prepareIntegrationSetup } from '@shared/lib/agent-integrations/setup'
import { getAgentIntegration, updateAgentIntegrationStatus } from '@shared/lib/services/agent-integration-service'
import router from './agent-integrations'
const prepare = vi.fn(async (_input: unknown, context: { callbackUrl: string }) => ({ config: { callbackUrl: context.callbackUrl }, status: 'disconnected' as const }))
agentIntegrationRegistry.register({
  definition: { provider: 'test-oauth', name: 'Test', family: 'task-manager', managementAccess: 'owner', capabilities: [], settings: [], setup: { kind: 'oauth', credentialFields: [] } },
  policy: { isAllowed: async () => true, sessionPolicy: () => ({ name: 'Test', metadata: {} }) },
  create: async () => { throw new Error('not needed') },
  serialize: row => ({ ...row, config: undefined, settings: {}, hasCredentials: row.status === 'active' }),
  setup: {
    prepare,
    authorize: { inputSchema: z.object({ clientId: z.string().min(1) }), async run(row) {
      const state = crypto.randomUUID(); pending.set(state, row.id)
      return { url: `https://provider.invalid/authorize?state=${state}` }
    } },
    async callback(input) {
      const id = pending.get(input.state)
      if (!id) throw new IntegrationSetupError('Invalid state')
      pending.delete(input.state)
      if (!input.code || input.error) return { cancelled: true }
      await updateAgentIntegrationStatus(id, 'active')
      return { integrationId: id }
    },
  },
})
const app = new Hono().route('/api/agent-integrations', router)
const headers = { Authorization: 'user-token', 'Content-Type': 'application/json' }
const create = () => app.request('/api/agent-integrations/agents/agent', { method: 'POST', headers, body: JSON.stringify({ provider: 'test-oauth', name: 'Agent identity', config: {} }) })
beforeEach(async () => { vi.clearAllMocks(); owner = true; pending.clear(); handle = await createTestDatabase(); testDb = handle.db })
afterEach(async () => { await handle.close(); vi.unstubAllEnvs() })
it('creates a registered non-chat provider through the canonical route without starting its unapproved runtime', async () => {
  vi.stubEnv('HOST_PUBLIC_URL', 'https://public.example/')
  const response = await create()
  expect(response.status).toBe(201)
  const row = await response.json()
  expect(row).toMatchObject({ provider: 'test-oauth', status: 'disconnected' })
  expect(prepare).toHaveBeenCalledWith({}, expect.objectContaining({ callbackUrl: 'https://public.example/api/agent-integrations/providers/test-oauth/callback', agentSlug: 'agent' }))
  expect(runtime.add).not.toHaveBeenCalled()
})
it('checks the owner before setup or authorization side effects, including agent-side creation', async () => {
  owner = false
  expect((await create()).status).toBe(403)
  expect(prepare).not.toHaveBeenCalled()
  owner = true; const row = await (await create()).json(); owner = false
  const response = await app.request(`/api/agent-integrations/${row.id}/authorize`, { method: 'POST', headers, body: JSON.stringify({ clientId: 'client' }) })
  expect(response.status).toBe(403)
  expect(runtime.pause).not.toHaveBeenCalled()
  await expect(prepareIntegrationSetup('test-oauth', {}, { agentSlug: 'agent', callbackUrl: 'https://host/callback' }, true)).rejects.toMatchObject({ status: 403 })
})
it.each(['providers/test-oauth', 'test-oauth'])('accepts a provider-validated callback without user cookies and rejects state replay (%s)', async path => {
  const row = await (await create()).json()
  const start = await app.request(`/api/agent-integrations/${row.id}/authorize`, { method: 'POST', headers, body: JSON.stringify({ clientId: 'client' }) })
  const state = new URL((await start.json()).url).searchParams.get('state')!
  const url = `/api/agent-integrations/${path}/callback?state=${state}&code=valid`
  expect((await app.request(url)).status).toBe(200)
  expect(runtime.add).toHaveBeenCalledExactlyOnceWith(row.id)
  expect((await app.request(url)).status).toBe(400)
  expect(runtime.add).toHaveBeenCalledOnce()
})
it('keeps completed authorization successful when the first connection fails transiently', async () => {
  const row = await (await create()).json()
  pending.set('state', row.id)
  runtime.add.mockRejectedValueOnce(new Error('Offline'))
  const response = await app.request('/api/agent-integrations/providers/test-oauth/callback?state=state&code=valid')
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('Account authorized')
  expect(await getAgentIntegration(row.id)).toMatchObject({ status: 'active' })
})
it('handles denial and malformed callbacks without starting an account', async () => {
  const row = await (await create()).json(); pending.set('state', row.id)
  const denied = await app.request('/api/agent-integrations/providers/test-oauth/callback?state=state&error=denied')
  expect(denied.status).toBe(400)
  expect(await denied.text()).toContain('cancelled')
  expect((await app.request('/api/agent-integrations/providers/test-oauth/callback?code=valid')).status).toBe(400)
  expect(runtime.add).not.toHaveBeenCalled()
})

it('validates replacement credentials before pausing the existing account', async () => {
  const row = await (await create()).json()
  const response = await app.request(`/api/agent-integrations/${row.id}/authorize`, { method: 'POST', headers, body: JSON.stringify({ clientId: '' }) })
  expect(response.status).toBe(400)
  expect(runtime.pause).not.toHaveBeenCalled()
})

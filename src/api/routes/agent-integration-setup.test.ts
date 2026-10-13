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
const runtime = vi.hoisted(() => ({ add: vi.fn(async (_id: string) => {}), pause: vi.fn(async (_id: string) => {}), resume: vi.fn(async (_id: string) => {}) }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: {
  addIntegration: runtime.add, pauseIntegration: runtime.pause, resumeIntegration: runtime.resume, integrationCreated: vi.fn(), isIntegrationConnected: () => false,
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
import { getAgentIntegration, listAgentIntegrations, updateAgentIntegrationStatus } from '@shared/lib/services/agent-integration-service'
import { captureException } from '@shared/lib/error-reporting'
import router from './agent-integrations'
const prepare = vi.fn(async (_input: unknown, context: { callbackUrl: string }) => ({ config: { callbackUrl: context.callbackUrl }, status: 'disconnected' as const }))
const describeSetup = vi.fn((context: { callbackUrl: string }, name?: string) => ({ redirectUri: context.callbackUrl, creationUrl: `https://provider.invalid/create?name=${encodeURIComponent(name ?? '')}` }))
agentIntegrationRegistry.register({
  definition: { provider: 'test-oauth', name: 'Test', family: 'task-manager', managementAccess: 'owner', capabilities: [], settings: [], setup: { kind: 'oauth', credentialFields: [] } },
  policy: { isAllowed: async () => true, sessionPolicy: () => ({ name: 'Test', metadata: {} }) },
  create: async () => { throw new Error('not needed') },
  serialize: row => ({ ...row, config: undefined, settings: {}, hasCredentials: row.status === 'active' }),
  setup: {
    describe: describeSetup,
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
      return { integrationId: id }
    },
  },
})
const app = new Hono().route('/api/agent-integrations', router)
const headers = { Authorization: 'user-token', 'Content-Type': 'application/json' }
const create = () => app.request('/api/agent-integrations/agents/agent', { method: 'POST', headers, body: JSON.stringify({ provider: 'test-oauth', name: 'Agent identity', config: {} }) })
beforeEach(async () => { vi.clearAllMocks(); owner = true; pending.clear(); handle = await createTestDatabase(); testDb = handle.db
  runtime.pause.mockImplementation(async id => { await updateAgentIntegrationStatus(id, 'paused') })
  runtime.resume.mockImplementation(async id => { await updateAgentIntegrationStatus(id, 'active') })
})
afterEach(async () => { await handle.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
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
  expect(await getAgentIntegration(row.id)).toMatchObject({ status: 'paused' })
  const state = new URL((await start.json()).url).searchParams.get('state')!
  const url = `/api/agent-integrations/${path}/callback?state=${state}&code=valid`
  expect((await app.request(url)).status).toBe(200)
  expect(runtime.resume).toHaveBeenCalledExactlyOnceWith(row.id)
  expect(await getAgentIntegration(row.id)).toMatchObject({ status: 'active' })
  expect((await app.request(url)).status).toBe(400)
  expect(runtime.resume).toHaveBeenCalledOnce()
  expect(captureException).not.toHaveBeenCalled()
})
it('keeps completed authorization successful when the first connection fails transiently', async () => {
  const row = await (await create()).json()
  pending.set('state', row.id)
  runtime.resume.mockImplementationOnce(async id => {
    await updateAgentIntegrationStatus(id, 'active')
    throw new Error('Offline')
  })
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

it('describes setup using the host callback without creating or connecting an installation', async () => {
  vi.stubEnv('HOST_PUBLIC_URL', 'https://public.example/')
  const response = await app.request('/api/agent-integrations/agents/agent/providers/test-oauth/setup?name=Release%20Assistant', { headers })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ transports: ['direct'], redirectUri: 'https://public.example/api/agent-integrations/providers/test-oauth/callback', creationUrl: 'https://provider.invalid/create?name=Release%20Assistant' })
  expect(await listAgentIntegrations()).toEqual([])
  expect(prepare).not.toHaveBeenCalled()
  expect(runtime.add).not.toHaveBeenCalled()
})
it('gates setup metadata with provider management access and validates the name', async () => {
  const url = '/api/agent-integrations/agents/agent/providers/test-oauth/setup'
  expect((await app.request(url)).status).toBe(401)
  owner = false
  expect((await app.request(url, { headers })).status).toBe(403)
  owner = true
  expect((await app.request(`${url}?name=${'a'.repeat(81)}`, { headers })).status).toBe(400)
  expect(describeSetup).not.toHaveBeenCalled()
  expect((await app.request('/api/agent-integrations/agents/agent/providers/missing/setup', { headers })).status).toBe(400)
})


it('keeps a working account active when provider authorization preparation fails', async () => {
  const row = await (await create()).json()
  await updateAgentIntegrationStatus(row.id, 'active')
  vi.spyOn(agentIntegrationRegistry.getProvider('test-oauth').setup!.authorize!, 'run')
    .mockRejectedValueOnce(new IntegrationSetupError('Invalid app credentials'))
  const response = await app.request(`/api/agent-integrations/${row.id}/authorize`, { method: 'POST', headers, body: JSON.stringify({ clientId: 'client' }) })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'Invalid app credentials' })
  expect(await getAgentIntegration(row.id)).toMatchObject({ status: 'active' })
  expect(runtime.pause).not.toHaveBeenCalled()
})
it('does not report malformed, unknown-provider or denied public callbacks as outages', async () => {
  const row = await (await create()).json(); pending.set('state', row.id)
  for (const path of ['missing/callback?state=state', 'test-oauth/callback?state=stale&code=valid', 'test-oauth/callback?code=valid', 'test-oauth/callback?state=state&error=denied']) {
    expect((await app.request(`/api/agent-integrations/providers/${path}`)).status).toBe(400)
  }
  expect(captureException).not.toHaveBeenCalled()
  expect(runtime.resume).not.toHaveBeenCalled()
})
it('still reports unexpected callback failures', async () => {
  const error = new Error('Provider service unavailable')
  vi.spyOn(agentIntegrationRegistry.getProvider('test-oauth').setup!, 'callback').mockRejectedValueOnce(error)
  expect((await app.request('/api/agent-integrations/providers/test-oauth/callback?state=state&code=valid')).status).toBe(400)
  expect(captureException).toHaveBeenCalledExactlyOnceWith(error, expect.objectContaining({ tags: expect.objectContaining({ operation: 'authorization-callback' }) }))
})
it('reserves the agent list URL for an agent named callback and enforces authentication', async () => {
  const path = '/api/agent-integrations/agents/callback'
  expect((await app.request(path)).status).toBe(401)
  const response = await app.request(path, { headers })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual([])
  expect(runtime.resume).not.toHaveBeenCalled()
})
it('uses the configured trusted origin behind a TLS-terminating proxy', async () => {
  vi.stubEnv('HOST_PUBLIC_URL', '')
  vi.stubEnv('TRUSTED_ORIGINS', 'https://gamut.example')
  const response = await app.request('http://internal:3000/api/agent-integrations/agents/agent/providers/test-oauth/setup', {
    headers: { ...headers, 'X-Forwarded-Host': 'untrusted.example', 'X-Forwarded-Proto': 'http' },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ redirectUri: 'https://gamut.example/api/agent-integrations/providers/test-oauth/callback' })
})
it('rejects iMessage credential tests without claiming that a code was verified', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const response = await app.request('/api/agent-integrations/test-credentials', { method: 'POST', headers, body: JSON.stringify({ provider: 'imessage', config: { phoneNumber: '+15555550100', code: '123456' } }) })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ valid: false, error: 'Credentials are verified when this integration connects' })
  expect(fetch).not.toHaveBeenCalled()
})
it('returns a setup error rather than signing the user out on an invalid iMessage code', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
  const response = await app.request('/api/agent-integrations/agents/agent', { method: 'POST', headers, body: JSON.stringify({ provider: 'imessage', config: { phoneNumber: '+15555550100', code: '123456' } }) })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'Invalid or expired code' })
  expect(await listAgentIntegrations()).toEqual([])
})

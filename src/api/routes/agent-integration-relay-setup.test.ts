import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
const runtime = vi.hoisted(() => ({ add: vi.fn(async (_id: string) => {}), remove: vi.fn(async (_id: string) => {}), pause: vi.fn(async (_id: string) => {}) }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: {
  addIntegration: runtime.add, removeIntegration: runtime.remove, pauseIntegration: runtime.pause, resumeIntegration: vi.fn(), integrationCreated: vi.fn(), isIntegrationConnected: () => false,
} }))
vi.mock('../middleware/auth', () => ({
  getAuthorizedAgentRole: () => 'owner',
  hasMinRole: () => true,
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentRead: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentUser: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  ResolveAgent: () => async (_c: unknown, next: () => Promise<void>) => next(), getAgentId: () => 'agent',
  EntityAgentRole: (options: { lookupFn: (id: string) => Promise<unknown>; contextKey: string }) => () => async (c: any, next: () => Promise<void>) => {
    const row = await options.lookupFn(c.req.param('integrationId'))
    if (!row) return c.json({ error: 'Not found' }, 404)
    c.set(options.contextKey, row); await next()
  },
}))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => 'owner' }))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn(async () => {}) }))
// The creator's platform member owns the endpoint.
vi.mock('@shared/lib/services/webhook-trigger-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/services/webhook-trigger-service')>()),
  resolvePlatformMemberForCandidates: async (candidates: string[]) => candidates.includes('owner') ? { userId: 'owner', memberId: 'sub_owner' } : null,
}))
const relay = vi.hoisted(() => ({
  create: vi.fn(async (_scope: string, spec: { name: string }) => ({ id: `whep_${relay.create.mock.calls.length}`, url: `https://relay.test/v1/hooks/whep_${relay.create.mock.calls.length}`, name: spec.name, status: 'active' })),
  disable: vi.fn(async (_scope: string, _id: string) => {}),
}))
vi.mock('@shared/lib/webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/webhook-relay')>()),
  getWebhookRelay: () => ({ createEndpoint: relay.create, disableEndpoint: relay.disable, register: vi.fn() }),
}))
import { agentIntegrationRegistry } from '@shared/lib/agent-integrations/registry'
import { getAgentIntegration, listAgentIntegrations, updateAgentIntegrationStatus } from '@shared/lib/services/agent-integration-service'
import { WebhookRelayUnavailableError } from '@shared/lib/webhook-relay'
import router from './agent-integrations'

function register(provider: string, transports: readonly ('direct' | 'relay')[]) {
  agentIntegrationRegistry.register({
    definition: { provider, name: provider === 'test-hooks' ? 'Hooks' : 'Relay Test', family: 'task-manager', capabilities: [], settings: [], setup: { kind: 'test', credentialFields: [] }, transports },
    policy: { isAllowed: async () => true, sessionPolicy: () => ({ name: 'Test', metadata: {} }) },
    create: async () => { throw new Error('not needed') },
    serialize: row => ({ ...row, config: undefined, settings: {}, hasCredentials: false }),
    configuration: { identityPaths: ['$.key'], uniqueKey: input => (input as { key?: string }).key ?? null, merge: stored => JSON.parse(stored) },
    setup: { prepare: async input => ({ config: { ...(input as Record<string, unknown>) }, status: 'disconnected' as const }) },
    // A settings change that needs a fresh connection, like a transport switch.
    updateSettings: async (_record, input) => ({ reconnect: !!(input.settings as { transport?: string } | undefined)?.transport }),
  })
}
register('test-relay', ['direct', 'relay'])
register('test-hooks', ['relay'])
const app = new Hono().route('/api/agent-integrations', router)
const headers = { Authorization: 'user-token', 'Content-Type': 'application/json' }
const create = (provider: string, config: Record<string, unknown>) =>
  app.request('/api/agent-integrations/agents/agent', { method: 'POST', headers, body: JSON.stringify({ provider, name: 'Identity', config }) })
async function storedConfig(id: string) { return JSON.parse((await getAgentIntegration(id))!.config) }

beforeEach(async () => {
  vi.clearAllMocks(); handle = await createTestDatabase(); testDb = handle.db
  vi.stubEnv('HOST_PUBLIC_URL', 'https://public.example/')
})
afterEach(async () => { await handle.close(); vi.unstubAllEnvs() })

it('mints the relay endpoint under the creator\'s member and stores it with the installation', async () => {
  const response = await create('test-relay', { transport: 'relay', key: 'a' })

  expect(response.status).toBe(201)
  const row = await response.json()
  expect(relay.create).toHaveBeenCalledExactlyOnceWith('sub_owner', { name: 'Relay Test integration for agent' })
  expect(await storedConfig(row.id)).toMatchObject({
    transport: 'relay',
    relay: { endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_owner' },
  })
})

it('mints nothing for a direct installation, and a relay-only provider needs no transport field', async () => {
  const direct = await (await create('test-relay', { key: 'a' })).json()
  expect(relay.create).not.toHaveBeenCalled()
  expect(await storedConfig(direct.id)).not.toHaveProperty('relay')

  const hooks = await (await create('test-hooks', { key: 'b' })).json()
  expect(await storedConfig(hooks.id)).toMatchObject({ transport: 'relay', relay: { endpointId: 'whep_1' } })
})

it('refuses a transport the provider does not support, before minting anything', async () => {
  const response = await create('test-hooks', { transport: 'direct', key: 'a' })

  expect(response.status).toBe(400)
  expect(relay.create).not.toHaveBeenCalled()
  expect(await listAgentIntegrations()).toEqual([])
})

it('explains a relay that is unavailable instead of failing the request', async () => {
  relay.create.mockRejectedValueOnce(new WebhookRelayUnavailableError('platform_disconnected'))

  const response = await create('test-relay', { transport: 'relay', key: 'a' })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'Webhooks are unavailable: the platform is not connected' })
})

it('disables the endpoint it minted when the installation is not created', async () => {
  await create('test-relay', { transport: 'relay', key: 'same' })

  const duplicate = await create('test-relay', { transport: 'relay', key: 'same' })

  expect(duplicate.status).toBe(409)
  expect(relay.disable).toHaveBeenCalledExactlyOnceWith('sub_owner', 'whep_2')
})

it('disables the endpoint when the installation is deleted', async () => {
  const row = await (await create('test-relay', { transport: 'relay', key: 'a' })).json()

  const response = await app.request(`/api/agent-integrations/${row.id}`, { method: 'DELETE', headers })

  expect(response.status).toBe(204)
  expect(runtime.pause).toHaveBeenCalledWith(row.id)
  expect(relay.disable).toHaveBeenCalledExactlyOnceWith('sub_owner', 'whep_1')
})

it('publishes the provider\'s transports with its setup links', async () => {
  const response = await app.request('/api/agent-integrations/agents/agent/providers/test-relay/setup', { headers })

  expect(await response.json()).toEqual({ transports: ['direct', 'relay'] })
})

it('reconnects an installation whose provider settings change needs it', async () => {
  const row = await (await create('test-relay', { key: 'a' })).json()
  const patch = (settings: Record<string, unknown>) => app.request(`/api/agent-integrations/${row.id}`, { method: 'PATCH', headers, body: JSON.stringify({ settings }) })

  expect((await patch({ runOnStatusChange: true })).status).toBe(200)
  expect(runtime.remove).not.toHaveBeenCalled()

  expect((await patch({ transport: 'relay' })).status).toBe(200)
  expect(runtime.remove).toHaveBeenCalledExactlyOnceWith(row.id)
  expect(runtime.add).toHaveBeenCalledWith(row.id)
})

it('keeps a saved settings change when the reconnect it needs fails, and reports it on the row', async () => {
  const row = await (await create('test-relay', { key: 'a' })).json()
  await updateAgentIntegrationStatus(row.id, 'active')
  runtime.add.mockRejectedValueOnce(new Error('Paste the webhook signing secret from your Linear app'))

  const response = await app.request(`/api/agent-integrations/${row.id}`, { method: 'PATCH', headers, body: JSON.stringify({ settings: { transport: 'relay' } }) })

  expect(response.status).toBe(200)
  expect(await getAgentIntegration(row.id)).toMatchObject({ status: 'error', errorMessage: 'Paste the webhook signing secret from your Linear app' })
})

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { chatIntegrations } from '@shared/lib/db/schema'
import { captureException } from '@shared/lib/error-reporting'
import { agentIntegrationManager } from '@shared/lib/agent-integrations/agent-integration-manager'
import { hasMinRole } from '@shared/lib/types/agent'
import { sql } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
const auth = vi.hoisted(() => ({ role: 'owner' as 'viewer' | 'user' | 'owner', lookups: 0 }))
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: vi.fn(async (token: string) => token === 'agent-token' ? 'agent' : null) }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: {
  pauseIntegration: vi.fn(async () => {}), isIntegrationConnected: () => false,
} }))
vi.mock('../middleware/auth', () => ({
  getAuthorizedAgentRole: () => auth.role,
  hasMinRole: (role: Parameters<typeof hasMinRole>[0], minimum: Parameters<typeof hasMinRole>[1]) => hasMinRole(role, minimum),
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentRead: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentUser: () => async (_c: unknown, next: () => Promise<void>) => next(),
  ResolveAgent: () => async (_c: unknown, next: () => Promise<void>) => next(), getAgentId: () => 'agent',
  EntityAgentRole: (options: { lookupFn: (id: string) => Promise<unknown>; contextKey: string }) => () => async (c: any, next: () => Promise<void>) => {
    auth.lookups++
    const row = await options.lookupFn(c.req.param('integrationId'))
    if (!row) return c.json({ error: 'Not found' }, 404)
    c.set(options.contextKey, row); await next()
  },
}))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => 'owner' }))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn(async () => {}) }))
import { agentIntegrationRegistry } from '@shared/lib/agent-integrations/registry'
import { createAgentIntegration, getAgentIntegration, updateAgentIntegrationStatus, listStartupAgentIntegrations } from '@shared/lib/services/agent-integration-service'
import { resetApplicationTables } from '@shared/lib/db/reset'
import { cleanupIntegrationResources } from '@shared/lib/agent-integrations/cleanup'
import management from './agent-integrations'
import discovery from './x-agent-integrations'
const child = sqliteTable('test_provider_state', { id: text('id').primaryKey() })
const cleanup = vi.fn(async () => {})
agentIntegrationRegistry.register({
  definition: { provider: 'test-tracker', name: 'Test tracker', family: 'task-manager', managementAccess: 'owner', capabilities: ['mcp'], settings: [], setup: { kind: 'test', credentialFields: [] } },
  policy: { isAllowed: async () => true, sessionPolicy: () => ({ name: 'Task', metadata: {} }) },
  create: async () => { throw new Error('No connection needed for management') }, storage: () => [child], cleanup,
  serialize: row => ({ ...row, config: undefined, settings: {}, hasCredentials: true }),
  mcp: async row => ({ integrationId: row.id, agentSlug: row.agentSlug, url: 'https://example.invalid/mcp', identity: { provider: 'test-tracker', name: 'Agent identity', workspace: 'Test team' },
    status: 'active', tools: [{ name: 'search', description: 'Search tasks', inputSchema: { type: 'object' } }],
    authorization: async () => 'secret', authRequired: async () => {}, reportHealth: async () => {},
  }),
})
const app = new Hono().route('/manage', management).route('/agent', discovery)
beforeEach(async () => {
  vi.clearAllMocks(); auth.role = 'owner'; auth.lookups = 0; handle = await createTestDatabase(); testDb = handle.db
  await testDb.run(sql`CREATE TABLE test_provider_state (id text primary key)`)
})
afterEach(async () => { await handle.close() })
it('lists and manages a registered non-chat provider through the common routes', async () => {
  const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'test-tracker', config: { credential: 'secret' } })
  const list = await app.request('/manage/agents/agent')
  expect(await list.json()).toMatchObject([{ id, provider: 'test-tracker', managementAccess: 'owner', connected: false }])
  const edit = await app.request(`/manage/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }) })
  expect(edit.status).toBe(200)
  expect(await getAgentIntegration(id)).toMatchObject({ name: 'Renamed' })
  expect((await app.request(`/manage/${id}`, { method: 'DELETE' })).status).toBe(204)
  expect(cleanup).toHaveBeenCalledOnce()
  expect(await getAgentIntegration(id)).toBeNull()
})
it('discovers all caller-owned integrations, including paused identities, without exposing secrets', async () => {
  const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'test-tracker', config: { credential: 'secret' } })
  await updateAgentIntegrationStatus(id, 'paused')
  await createAgentIntegration({ agentSlug: 'other', provider: 'test-tracker', config: {} })
  await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'test-token' } })
  expect((await app.request('/agent/list', { method: 'POST' })).status).toBe(401)
  const response = await app.request('/agent/list', { method: 'POST', headers: { Authorization: 'Bearer agent-token' }, body: JSON.stringify({ agentSlug: 'other' }) })
  const result = await response.json()
  expect(result.integrations).toHaveLength(2)
  expect(result.integrations).toContainEqual(expect.objectContaining({ id, status: 'paused', family: 'task-manager', mcp: null }))
  expect(JSON.stringify(result)).not.toContain('secret')
  expect(JSON.stringify(result)).not.toContain('test-token')
})
it('cleans and resets provider-owned resources through registered hooks and table ownership', async () => {
  await createAgentIntegration({ agentSlug: 'agent', provider: 'test-tracker', config: {} })
  await testDb.run(sql`INSERT INTO test_provider_state VALUES ('one')`)
  await cleanupIntegrationResources('agent')
  expect(cleanup).toHaveBeenCalledOnce()
  await resetApplicationTables()
  expect(await testDb.select().from(child).all()).toEqual([])
})

it('isolates unavailable providers and corrupt configs in management and agent discovery', async () => {
  const healthy = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'secret-token' } })
  await testDb.insert(chatIntegrations).values([
    { id: 'unavailable', agentSlug: 'agent', provider: 'uninstalled' as 'telegram', config: '{"credential":"private-token"}', createdAt: new Date(), updatedAt: new Date() },
    { id: 'damaged', agentSlug: 'agent', provider: 'slack', config: 'not-json', createdAt: new Date(), updatedAt: new Date() },
  ]).run()
  expect((await listStartupAgentIntegrations()).map(row => row.id)).not.toContain('unavailable')
  const management = await app.request('/manage/agents/agent')
  expect(management.status).toBe(200)
  const rows = await management.json()
  expect(rows).toHaveLength(3)
  expect(rows).toContainEqual(expect.objectContaining({ id: healthy, hasCredentials: true }))
  expect(rows).toContainEqual(expect.objectContaining({ id: 'unavailable', managementAccess: 'owner', capabilities: [], hasCredentials: false }))
  const discovery = await app.request('/agent/list', { method: 'POST', headers: { Authorization: 'Bearer agent-token' } })
  expect(discovery.status).toBe(200)
  const inventory = await discovery.json()
  expect(inventory.integrations).toContainEqual(expect.objectContaining({ id: 'unavailable', family: 'unknown', capabilities: [], mcp: null }))
  expect(inventory.integrations).toContainEqual(expect.objectContaining({ id: healthy, capabilities: ['send_message'] }))
  expect(JSON.stringify([rows, inventory])).not.toMatch(/secret-token|private-token/)
  expect((await app.request('/manage/unavailable', { method: 'DELETE' })).status).toBe(204)
})

it('exposes MCP only while the parent installation is available to the runtime', async () => {
  const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'test-tracker', config: {} })
  const list = async () => (await (await app.request('/agent/list', { method: 'POST', headers: { Authorization: 'Bearer agent-token' } })).json()).integrations
  expect(await list()).toContainEqual(expect.objectContaining({ id, mcp: expect.objectContaining({ status: 'active', tools: ['search'] }) }))
  await updateAgentIntegrationStatus(id, 'paused')
  const mcp = vi.spyOn(agentIntegrationRegistry, 'getMcpConnection')
  expect(await list()).toContainEqual(expect.objectContaining({ id, mcp: null }))
  expect(mcp).not.toHaveBeenCalled()
  mcp.mockRestore()
})

it('continues cleanup after a provider failure and allows deleting the failed installation', async () => {
  const first = await createAgentIntegration({ agentSlug: 'agent', provider: 'test-tracker', config: {} })
  const second = await createAgentIntegration({ agentSlug: 'agent', provider: 'test-tracker', config: {} })
  cleanup.mockRejectedValueOnce(new Error('Remote service unavailable'))
  await cleanupIntegrationResources('agent')
  expect(cleanup).toHaveBeenCalledTimes(2)
  expect(agentIntegrationManager.pauseIntegration).toHaveBeenCalledWith(first)
  expect(agentIntegrationManager.pauseIntegration).toHaveBeenCalledWith(second)
  expect(captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { component: 'agent-integration', operation: 'cleanup' } }))
  cleanup.mockRejectedValueOnce(new Error('Remote service still unavailable'))
  expect((await app.request(`/manage/${first}`, { method: 'DELETE' })).status).toBe(204)
  expect(await getAgentIntegration(first)).toBeNull()
})

it('uses the already-authorized owner role without a second entity lookup', async () => {
  const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'test-tracker', config: {} })
  auth.role = 'user'
  expect((await app.request(`/manage/${id}`, { method: 'DELETE' })).status).toBe(403)
  expect(auth.lookups).toBe(1)
  expect(agentIntegrationManager.pauseIntegration).not.toHaveBeenCalled()
  auth.role = 'owner'
  expect((await app.request(`/manage/${id}`, { method: 'DELETE' })).status).toBe(204)
  expect(auth.lookups).toBe(2)
})

it('validates provider-independent JSON writes and rejects unsupported config edits as a client error', async () => {
  await expect(createAgentIntegration({ agentSlug: 'agent', provider: 'test-tracker', config: { invalid: () => 'silently dropped' } })).rejects.toThrow()
  const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'test-tracker', config: { credential: 'kept' } })
  const response = await app.request(`/manage/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { credential: 'changed' } }) })
  expect(response.status).toBe(400)
  expect((await getAgentIntegration(id))?.config).toBe('{"credential":"kept"}')
})

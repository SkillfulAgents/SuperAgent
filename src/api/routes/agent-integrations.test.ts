vi.mock('@shared/lib/services/connection-sync-service', () => ({ syncRemoteMcpAgents: vi.fn(async () => true) }))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { sql } from 'drizzle-orm'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
const auth = vi.hoisted(() => ({ role: 'owner' }))
vi.mock('../middleware/auth', () => {
  const rank: Record<string, number> = { viewer: 0, user: 1, owner: 2 }
  const role = (minimum: string) => async (c: any, next: () => Promise<void>) => rank[auth.role] >= rank[minimum] ? next() : c.json({ error: 'Forbidden' }, 403)
  return {
    getAuthorizedAgentRole: () => auth.role,
    hasMinRole: (actual: string, minimum: string) => rank[actual] >= rank[minimum],
    Authenticated: () => async (_c: any, next: () => Promise<void>) => next(),
    AgentRead: () => role('viewer'), AgentUser: () => role('user'), AgentAdmin: () => role('owner'),
    ResolveAgent: () => async (_c: any, next: () => Promise<void>) => next(), getAgentId: (c: any) => c.req.param('id'),
    EntityAgentRole: (options: any) => (minimum: string) => async (c: any, next: () => Promise<void>) => {
      const row = await options.lookupFn(c.req.param(options.paramName))
      if (!row) return c.json({ error: 'Not found' }, 404)
      c.set(options.contextKey, row)
      return role(minimum)(c, next)
    },
  }
})
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => 'owner' }))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
const manager = vi.hoisted(() => ({ getConnector: vi.fn(), isIntegrationConnected: vi.fn(() => false),
  addIntegration: vi.fn(), pauseIntegration: vi.fn(), resumeIntegration: vi.fn(), removeIntegration: vi.fn(), clearSessionById: vi.fn(), integrationCreated: vi.fn() }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: manager }))
const cleanup = vi.hoisted(() => vi.fn())
vi.mock('@shared/lib/agent-integrations/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('@shared/lib/agent-integrations/registry')>()
  actual.agentIntegrationRegistry.cleanup = cleanup
  return actual
})
import router from './agent-integrations'
import { captureException } from '@shared/lib/error-reporting'
import { createAgentIntegration, getAgentIntegration } from '@shared/lib/services/agent-integration-service'
import { createAgentIntegrationSession, listAgentIntegrationSessions } from '@shared/lib/services/agent-integration-session-service'
import { getLinearConfig, updateLinearConfig } from '@shared/lib/task-manager-integrations/linear/store'

const app = new Hono().route('/api/agent-integrations', router)
let id: string
beforeEach(async () => {
  vi.clearAllMocks(); auth.role = 'owner'
  handle = await createTestDatabase(); testDb = handle.db
  id = (await createAgentIntegration({ agentSlug: 'agent', provider: 'linear', name: 'Helper', config: {
    redirectUri: 'https://gamut.example/callback', clientId: 'client-id', clientSecret: 'client-secret',
    identity: { appUserId: 'app', appName: 'Helper', workspaceId: 'workspace', workspaceName: 'Test' },
    tokens: { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: Date.now() + 3600000, scope: 'read write app:mentionable app:assignable' },
  } }))
})
afterEach(async () => { await handle.close(); vi.unstubAllGlobals() })
function patch(body: unknown) { return app.request(`/api/agent-integrations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
describe('shared integration API', () => {
  it('creates Linear through the shared provider setup contract and requires ownership', async () => {
    const create = () => app.request('/api/agent-integrations/agents/agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'linear', name: 'New helper', config: {} }),
    })
    auth.role = 'user'
    expect((await create()).status).toBe(403)
    auth.role = 'owner'
    const response = await create()
    expect(response.status).toBe(201)
    const created = await response.json()
    expect(created).toMatchObject({ provider: 'linear', status: 'disconnected', hasCredentials: false, name: 'New helper' })
    expect(created.linear.setup.redirectUri).toContain('/api/agent-integrations/providers/linear/callback')
    expect(manager.addIntegration).not.toHaveBeenCalled()
    expect(await getLinearConfig(created.id)).toMatchObject({ runOnStatusChange: false })
  })
  it('lists all providers and serves a credential-free common detail contract', async () => {
    await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'telegram-secret' } })
    const response = await app.request('/api/agent-integrations/agents/agent')
    expect(response.status).toBe(200)
    const rows = await response.json()
    expect(rows.map((row: { provider: string }) => row.provider).sort()).toEqual(['linear', 'telegram'])
    const detail = await app.request(`/api/agent-integrations/${id}`)
    expect(detail.status).toBe(200)
    const row = await detail.json()
    expect(row).toMatchObject({ id, provider: 'linear', name: 'Helper', hasCredentials: true, managementAccess: 'owner', capabilities: [], settings: { runOnStatusChange: false } })
    for (const secret of ['client-secret', 'access-secret', 'refresh-secret', 'telegram-secret']) expect(JSON.stringify(rows)).not.toContain(secret)
    expect(row).not.toHaveProperty('config')
  })
  it('uses the shared rename/model/settings controls without changing credentials', async () => {
    expect((await patch({ name: 'Renamed', model: 'sonnet', effort: 'high', settings: { runOnStatusChange: true } })).status).toBe(200)
    expect(await getAgentIntegration(id)).toMatchObject({ name: 'Renamed', model: 'sonnet', effort: 'high' })
    expect(await getLinearConfig(id)).toMatchObject({ runOnStatusChange: true, clientSecret: 'client-secret' })
    expect((await patch({ config: { clientSecret: 'replacement' } })).status).toBe(400)
    expect((await patch({ sessionTimeout: 1 })).status).toBe(400)
  })
  it('requires owner permission for Linear changes and deletion, but permits reading', async () => {
    auth.role = 'user'
    expect((await app.request(`/api/agent-integrations/${id}`)).status).toBe(200)
    expect((await patch({ status: 'paused' })).status).toBe(403)
    expect((await app.request(`/api/agent-integrations/${id}`, { method: 'DELETE' })).status).toBe(403)
    expect(manager.pauseIntegration).not.toHaveBeenCalled()
    expect(await getAgentIntegration(id)).not.toBeNull()
  })
  it('preserves the issue session when a client tries to reset it', async () => {
    const sessionId = await createAgentIntegrationSession({ integrationId: id, externalChatId: 'issue', sessionId: 'sdk-session' })
    const response = await app.request(`/api/agent-integrations/${id}/sessions/${sessionId}`, { method: 'DELETE' })
    expect(response.status).toBe(400)
    expect(manager.clearSessionById).not.toHaveBeenCalled()
    expect((await listAgentIntegrationSessions(id))[0].archivedAt).toBeNull()
  })
  it('cleans up provider authorization before deleting the installation', async () => {
    expect((await app.request(`/api/agent-integrations/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ id, provider: 'linear' }))
    expect(await getAgentIntegration(id)).toBeNull()
  })
  it('records denied OAuth and exposes reconnect needed in the shared detail and list APIs', async () => {
    const start = await app.request(`/api/agent-integrations/${id}/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(start.status).toBe(200)
    const { url } = await start.json()
    const state = new URL(url).searchParams.get('state')!
    const cancelled = await app.request(`/api/agent-integrations/linear/callback?state=${state}&error=access_denied`)
    expect(cancelled.status).toBe(400)
    const detail = await (await app.request(`/api/agent-integrations/${id}`)).json()
    expect(detail).toMatchObject({ reconnectRequired: true, hasCredentials: false, linear: { authorizationState: 'reconnect_needed' } })
    const rows = await (await app.request('/api/agent-integrations/agents/agent')).json()
    expect(rows[0].reconnectRequired).toBe(true)
    const retry = await app.request(`/api/agent-integrations/${id}/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(retry.status).toBe(200)
    expect((await retry.json()).url).not.toBe(url)
  })
  it('does not pause a healthy integration for malformed replacement credentials', async () => {
    const response = await app.request(`/api/agent-integrations/${id}/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'missing-secret' }) })
    expect(response.status).toBe(400)
    expect(manager.pauseIntegration).not.toHaveBeenCalled()
  })

  it('keeps healthy integrations and deletion controls available when one Linear config is corrupt', async () => {
    await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'telegram-secret' } })
    await testDb.run(sql`UPDATE chat_integrations SET config = ${'{bad private data'} WHERE id = ${id}`)
    const response = await app.request('/api/agent-integrations/agents/agent')
    expect(response.status).toBe(200)
    const rows = await response.json()
    expect(rows).toHaveLength(2)
    expect(rows.find((row: { provider: string }) => row.provider === 'telegram')).toMatchObject({ hasCredentials: true })
    expect(rows.find((row: { id: string }) => row.id === id)).toMatchObject({ id, hasCredentials: false, managementAccess: 'owner' })
    expect(JSON.stringify(rows)).not.toContain('private data')
    expect((await app.request(`/api/agent-integrations/${id}`)).status).toBe(200)
    expect((await app.request(`/api/agent-integrations/${id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it.each(['unknown-state', 'expired-state', 'rejected-code'])('does not report an expected Linear callback rejection: %s', async failure => {
    const start = await app.request(`/api/agent-integrations/${id}/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    let state = new URL((await start.json()).url).searchParams.get('state')!
    if (failure === 'unknown-state') state = 'invalid-state'
    if (failure === 'expired-state') await updateLinearConfig(id, config => ({ ...config, oauth: { ...config.oauth!, expiresAt: 1 } }))
    const fetch = vi.fn(async () => new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const response = await app.request(`/api/agent-integrations/providers/linear/callback?state=${state}&code=invalid`)
    expect(response.status).toBe(400)
    expect(captureException).not.toHaveBeenCalled()
    expect(manager.resumeIntegration).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(failure === 'rejected-code' ? 1 : 0)
  })

  it('keeps successful authorization when the initial connection fails transiently', async () => {
    const start = await app.request(`/api/agent-integrations/${id}/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const state = new URL((await start.json()).url).searchParams.get('state')!
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/oauth/token')
      ? { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'read write app:mentionable app:assignable' }
      : { data: { viewer: { id: 'app', app: true, name: 'Helper', displayName: 'Helper', avatarUrl: null, organization: { id: 'workspace', name: 'Test' } } } })))
    manager.resumeIntegration.mockRejectedValueOnce(new Error('Linear request failed (503)'))
    const response = await app.request(`/api/agent-integrations/linear/callback?state=${state}&code=code`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('retry automatically')
    expect(await getLinearConfig(id)).toMatchObject({ tokens: { accessToken: 'new-access' }, authorizationPending: false })
  })

})

it('applies provider-owned serialization, write permission and settings without a Linear identity check', async () => {
  const { agentIntegrationRegistry } = await import('@shared/lib/agent-integrations/registry')
  const original = agentIntegrationRegistry.getProvider('telegram')
  const settings = vi.fn(async () => {})
  const implementation = { ...original, definition: { ...original.definition, family: 'task-manager', managementAccess: 'owner' as const },
    updateSettings: settings, serialize: (record: Parameters<typeof original.create>[0]) => ({
      id: record.id, agentSlug: record.agentSlug, provider: record.provider, name: record.name, status: record.status,
      errorMessage: null, createdByUserId: record.createdByUserId, model: record.model, effort: record.effort, speed: record.speed,
      createdAt: record.createdAt, updatedAt: record.updatedAt, hasCredentials: true, settings: { providerOwned: true },
    }) }
  const provider = vi.spyOn(agentIntegrationRegistry, 'getProvider').mockImplementation(name => name === 'telegram' ? implementation : original)
  const definition = vi.spyOn(agentIntegrationRegistry, 'getDefinition').mockImplementation(name => name === 'telegram' ? implementation.definition : original.definition)
  try {
    id = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'test' } })
    const detail = await (await app.request(`/api/agent-integrations/${id}`)).json()
    expect(detail).toMatchObject({ managementAccess: 'owner', settings: { providerOwned: true } })
    auth.role = 'user'
    expect((await patch({ name: 'Denied' })).status).toBe(403)
    expect(settings).not.toHaveBeenCalled()
    auth.role = 'owner'
    expect((await patch({ name: 'Allowed' })).status).toBe(200)
    expect(settings).toHaveBeenCalledWith(expect.objectContaining({ id }), { name: 'Allowed' })
  } finally { provider.mockRestore(); definition.mockRestore() }
})

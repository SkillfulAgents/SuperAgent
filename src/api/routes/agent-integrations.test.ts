import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '@shared/lib/db/schema'
let sqlite: InstanceType<typeof Database>
let testDb: ReturnType<typeof drizzle>
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
const auth = vi.hoisted(() => ({ role: 'owner' }))
vi.mock('../middleware/auth', () => {
  const rank: Record<string, number> = { viewer: 0, user: 1, owner: 2 }
  const role = (minimum: string) => async (c: any, next: () => Promise<void>) => rank[auth.role] >= rank[minimum] ? next() : c.json({ error: 'Forbidden' }, 403)
  return {
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
  addIntegration: vi.fn(), pauseIntegration: vi.fn(), resumeIntegration: vi.fn(), removeIntegration: vi.fn(), clearSessionById: vi.fn() }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: manager }))
const cleanup = vi.hoisted(() => vi.fn())
vi.mock('@shared/lib/agent-integrations/registry', () => ({ agentIntegrationRegistry: { cleanup } }))
import router from './agent-integrations'
import { createChatIntegration, getChatIntegration } from '@shared/lib/services/chat-integration-service'
import { createChatIntegrationSession, listChatIntegrationSessions } from '@shared/lib/services/chat-integration-session-service'
import { getLinearConfig } from '@shared/lib/task-manager-integrations/linear/store'

const app = new Hono().route('/api/agent-integrations', router)
let id: string
beforeEach(() => {
  vi.clearAllMocks(); auth.role = 'owner'
  sqlite = new Database(':memory:'); testDb = drizzle(sqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
  id = createChatIntegration({ agentSlug: 'agent', provider: 'linear', name: 'Helper', config: {
    redirectUri: 'https://gamut.example/callback', clientId: 'client-id', clientSecret: 'client-secret',
    identity: { appUserId: 'app', appName: 'Helper', workspaceId: 'workspace', workspaceName: 'Test' },
    tokens: { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: Date.now() + 3600000, scope: 'read write app:mentionable app:assignable' },
  } })
})
afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })
function patch(body: unknown) { return app.request(`/api/agent-integrations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
describe('shared integration API', () => {
  it('lists all providers and serves a credential-free common detail contract', async () => {
    createChatIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'telegram-secret' } })
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
    expect((await patch({ name: 'Renamed', model: 'sonnet', effort: 'high', runOnStatusChange: true })).status).toBe(200)
    expect(getChatIntegration(id)).toMatchObject({ name: 'Renamed', model: 'sonnet', effort: 'high' })
    expect(getLinearConfig(id)).toMatchObject({ runOnStatusChange: true, clientSecret: 'client-secret' })
    expect((await patch({ config: { clientSecret: 'replacement' } })).status).toBe(400)
    expect((await patch({ sessionTimeout: 1 })).status).toBe(400)
  })
  it('requires owner permission for Linear changes and deletion, but permits reading', async () => {
    auth.role = 'user'
    expect((await app.request(`/api/agent-integrations/${id}`)).status).toBe(200)
    expect((await patch({ status: 'paused' })).status).toBe(403)
    expect((await app.request(`/api/agent-integrations/${id}`, { method: 'DELETE' })).status).toBe(403)
    expect(manager.pauseIntegration).not.toHaveBeenCalled()
    expect(getChatIntegration(id)).not.toBeNull()
  })
  it('preserves the issue session when a client tries to reset it', async () => {
    const sessionId = createChatIntegrationSession({ integrationId: id, externalChatId: 'issue', sessionId: 'sdk-session' })
    const response = await app.request(`/api/agent-integrations/${id}/sessions/${sessionId}`, { method: 'DELETE' })
    expect(response.status).toBe(400)
    expect(manager.clearSessionById).not.toHaveBeenCalled()
    expect(listChatIntegrationSessions(id)[0].archivedAt).toBeNull()
  })
  it('cleans up provider authorization before deleting the installation', async () => {
    expect((await app.request(`/api/agent-integrations/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ id, provider: 'linear' }))
    expect(getChatIntegration(id)).toBeNull()
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
    createChatIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'telegram-secret' } })
    sqlite.prepare('UPDATE chat_integrations SET config = ? WHERE id = ?').run('{bad private data', id)
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

  it('keeps successful authorization when initial event sync fails transiently', async () => {
    const start = await app.request(`/api/agent-integrations/${id}/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const state = new URL((await start.json()).url).searchParams.get('state')!
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/oauth/token')
      ? { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'read write app:mentionable app:assignable' }
      : { data: { viewer: { id: 'app', app: true, name: 'Helper', displayName: 'Helper', avatarUrl: null, organization: { id: 'workspace', name: 'Test' } } } })))
    manager.addIntegration.mockRejectedValueOnce(new Error('Linear request failed (503)'))
    const response = await app.request(`/api/agent-integrations/linear/callback?state=${state}&code=code`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('retry automatically')
    expect(getLinearConfig(id)).toMatchObject({ tokens: { accessToken: 'new-access' }, authorizationPending: false })
  })

})

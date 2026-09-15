import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../../db/schema'
let sqlite: InstanceType<typeof Database>
let testDb: ReturnType<typeof drizzle>
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('../../services/webhook-trigger-service', () => ({ resolvePlatformMemberForCandidates: () => ({ memberId: 'member', userId: 'owner' }) }))
vi.mock('../../services/platform-auth-service', () => ({ getStoredPlatformMemberId: () => 'member' }))
vi.mock('../../services/webhook-endpoints-client', () => ({
  createPlatformWebhookEndpoint: vi.fn(async () => ({ id: 'endpoint', url: 'https://relay.example/hooks/test' })),
  updatePlatformWebhookEndpoint: vi.fn(async () => ({})), disablePlatformWebhookEndpoint: vi.fn(async () => {}),
}))
import { createLinearSetup, authorizeLinearSetup, completeLinearSetup, publicLinearIntegration, deleteLinearSetup } from './setup'
import { getLinearConfig, updateLinearConfig } from './store'
import { LinearClient } from './client'
import { z } from 'zod'
import { getChatIntegration } from '../../services/chat-integration-service'
import { disablePlatformWebhookEndpoint } from '../../services/webhook-endpoints-client'
const scopes = 'read write app:mentionable app:assignable'
const identity = { id: 'app-user', app: true, name: 'Helper', displayName: 'Helper', avatarUrl: null, organization: { id: 'workspace', name: 'Team' } }
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  sqlite = new Database(':memory:'); testDb = drizzle(sqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
  vi.clearAllMocks()
  fetchMock = vi.fn(async (url: string) => Response.json(url.endsWith('/oauth/token')
    ? { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 86400, scope: scopes }
    : { data: { viewer: identity } }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })
async function setup(agentSlug = 'agent') {
  const integration = await createLinearSetup(agentSlug, 'Helper', 'owner', 'http://localhost:47897')
  const url = await authorizeLinearSetup(integration.id, { clientId: 'client', clientSecret: 'client-secret', webhookSecret: 'signing-secret' })
  return { id: integration.id, state: new URL(url).searchParams.get('state')! }
}
describe('Linear identity lifecycle', () => {
  it('uses a one-use OAuth state and never exposes credentials publicly', async () => {
    const { id, state } = await setup()
    expect(getChatIntegration(id)?.status).toBe('disconnected')
    expect(await completeLinearSetup(state, 'code')).toBe(id)
    expect(getChatIntegration(id)?.status).toBe('active')
    expect(getLinearConfig(id).identity).toMatchObject({ appUserId: 'app-user', workspaceId: 'workspace' })
    await expect(completeLinearSetup(state, 'code')).rejects.toThrow('expired')
    const output = JSON.stringify(publicLinearIntegration(id))
    for (const secret of ['access-secret', 'refresh-secret', 'client-secret', 'signing-secret']) expect(output).not.toContain(secret)
    const body = fetchMock.mock.calls[0][1] as RequestInit
    expect(String(body.body)).toContain('code_verifier=')
  })
  it('rejects expired state, personal tokens, and a shared app identity', async () => {
    const first = await setup()
    updateLinearConfig(first.id, config => ({ ...config, oauth: { ...config.oauth!, expiresAt: 1 } }))
    await expect(completeLinearSetup(first.state, 'code')).rejects.toThrow('expired')
    const personal = await setup('personal')
    fetchMock.mockImplementation(async (url: string) => Response.json(url.endsWith('/oauth/token')
      ? { access_token: 'access', refresh_token: 'refresh', expires_in: 86400, scope: scopes }
      : { data: { viewer: { ...identity, app: false } } }))
    await expect(completeLinearSetup(personal.state, 'code')).rejects.toThrow('personal account')
    fetchMock.mockImplementation(async (url: string) => Response.json(url.endsWith('/oauth/token')
      ? { access_token: 'access', refresh_token: 'refresh', expires_in: 86400, scope: scopes }
      : { data: { viewer: identity } }))
    const owned = await setup('owned'); await completeLinearSetup(owned.state, 'code')
    const duplicate = await setup('other')
    await expect(completeLinearSetup(duplicate.state, 'code')).rejects.toThrow('separate app')
    expect(getLinearConfig(duplicate.id).tokens).toBeUndefined()
  })
  it('renews once for concurrent API requests and preserves changed settings', async () => {
    const { id, state } = await setup(); await completeLinearSetup(state, 'code')
    updateLinearConfig(id, config => ({ ...config, tokens: { ...config.tokens!, expiresAt: 1 } }))
    fetchMock.mockClear()
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/token')) {
        updateLinearConfig(id, config => ({ ...config, runOnStatusChange: true }))
        return Response.json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 86400, scope: scopes })
      }
      return Response.json({ data: { ok: true } })
    })
    const client = new LinearClient(id)
    await Promise.all([client.request('query{ok}', {}, z.object({ ok: z.boolean() })), client.request('query{ok}', {}, z.object({ ok: z.boolean() }))])
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/oauth/token'))).toHaveLength(1)
    expect(getLinearConfig(id)).toMatchObject({ runOnStatusChange: true, tokens: { refreshToken: 'rotated' } })
  })
  it('does not resurrect tokens revoked while renewal is in flight', async () => {
    const { id, state } = await setup(); await completeLinearSetup(state, 'code')
    updateLinearConfig(id, config => ({ ...config, tokens: { ...config.tokens!, expiresAt: 1 } }))
    fetchMock.mockImplementation(async () => {
      updateLinearConfig(id, config => ({ ...config, tokens: undefined }))
      return Response.json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 86400, scope: scopes })
    })
    await expect(new LinearClient(id).identity()).rejects.toThrow('changed during renewal')
    expect(getLinearConfig(id).tokens).toBeUndefined()
  })
  it('disables the endpoint and revokes authorization before deleting local state', async () => {
    const { id, state } = await setup(); await completeLinearSetup(state, 'code')
    fetchMock.mockClear(); fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    await deleteLinearSetup(id)
    expect(disablePlatformWebhookEndpoint).toHaveBeenCalledWith('member', 'endpoint')
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.linear.app/oauth/revoke')
    expect(getChatIntegration(id)).toBeNull()
  })
})

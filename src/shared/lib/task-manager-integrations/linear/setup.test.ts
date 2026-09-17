import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../../db/schema'
let sqlite: InstanceType<typeof Database>
let testDb: ReturnType<typeof drizzle>
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
import { createLinearSetup, authorizeLinearSetup, completeLinearSetup, deleteLinearSetup, failLinearSetup, publicLinearIntegration } from './setup'
import { getLinearConfig, updateLinearConfig } from './store'
import { toPublicAgentIntegration } from '../../agent-integrations/serialization'
import { LinearClient } from './client'
import { z } from 'zod'
import { getChatIntegration } from '../../services/chat-integration-service'
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
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
async function setup(agentSlug = 'agent') {
  const integration = await createLinearSetup(agentSlug, 'Helper', 'owner', 'http://localhost:47897')
  const url = await authorizeLinearSetup(integration.id, { clientId: 'client', clientSecret: 'client-secret' })
  return { id: integration.id, state: new URL(url).searchParams.get('state')! }
}
describe('Linear identity lifecycle', () => {
  it('uses the configured HTTPS callback behind a TLS-terminating proxy', async () => {
    vi.stubEnv('HOST_PUBLIC_URL', 'https://dev.example:8443/')
    const integration = await createLinearSetup('agent', 'Helper', 'owner', 'http://dev.example:8443')
    expect(integration.setup.redirectUri).toBe('https://dev.example:8443/api/agent-integrations/linear/callback')
    expect(new URL(integration.setup.creationUrl).searchParams.get('oauth.redirect_uris')).toBe(integration.setup.redirectUri)
  })

  it('creates a private app manifest without platform login or webhooks', async () => {
    const integration = await createLinearSetup('agent', 'Helper', 'owner', 'http://localhost:47897')
    const url = new URL(integration.setup.creationUrl)
    expect(url.searchParams.get('webhook.enabled')).toBe('false')
    expect(url.searchParams.get('distribution')).toBe('private')
    expect(url.searchParams.has('webhook.url')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses a one-use OAuth state and never exposes credentials publicly', async () => {
    const { id, state } = await setup()
    expect(getChatIntegration(id)?.status).toBe('disconnected')
    expect(await completeLinearSetup(state, 'code')).toBe(id)
    expect(getChatIntegration(id)?.status).toBe('active')
    expect(getLinearConfig(id).identity).toMatchObject({ appUserId: 'app-user', workspaceId: 'workspace' })
    await expect(completeLinearSetup(state, 'code')).rejects.toThrow('expired')
    const publicIntegration = toPublicAgentIntegration(getChatIntegration(id)!)
    expect(publicIntegration).toMatchObject({ provider: 'linear', hasCredentials: true, capabilities: [], managementAccess: 'owner', linear: { authorized: true } })
    const output = JSON.stringify(publicIntegration)
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
  it('revokes authorization before deleting local state', async () => {
    const { id, state } = await setup(); await completeLinearSetup(state, 'code')
    fetchMock.mockClear(); fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    await deleteLinearSetup(id)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.linear.app/oauth/revoke')
    expect(getChatIntegration(id)).toBeNull()
  })
  it('exposes failed and expired attempts as reconnect needed and retries with saved credentials', async () => {
    const { id, state } = await setup()
    const normal = fetchMock.getMockImplementation()!
    fetchMock.mockResolvedValueOnce(new Response('private provider error', { status: 400 }))
    await expect(completeLinearSetup(state, 'bad-code')).rejects.toThrow('authorization failed')
    expect(toPublicAgentIntegration(getChatIntegration(id)!)).toMatchObject({ reconnectRequired: true, hasCredentials: false,
      linear: { authorizationState: 'reconnect_needed', canReconnect: true } })
    expect(JSON.stringify(publicLinearIntegration(id))).not.toContain('private provider error')
    const retry = await authorizeLinearSetup(id, {})
    const retryState = new URL(retry).searchParams.get('state')!
    expect(retryState).not.toBe(state)
    expect(publicLinearIntegration(id).authorizationState).toBe('pending')
    failLinearSetup(state, 'stale failure')
    await expect(completeLinearSetup(state, 'old-code')).rejects.toThrow('expired')
    expect(publicLinearIntegration(id).authorizationState).toBe('pending')
    updateLinearConfig(id, config => ({ ...config, oauth: { ...config.oauth!, expiresAt: 1 } }))
    expect(publicLinearIntegration(id)).toMatchObject({ authorizationState: 'reconnect_needed', authorizationMessage: expect.stringContaining('expired') })
    const next = await authorizeLinearSetup(id, {})
    fetchMock.mockImplementation(normal)
    await completeLinearSetup(new URL(next).searchParams.get('state')!, 'good-code')
    expect(toPublicAgentIntegration(getChatIntegration(id)!)).toMatchObject({ reconnectRequired: false, hasCredentials: true,
      linear: { authorizationState: 'connected', authorizationMessage: null } })
  })
  it('does not let a stale in-flight failure overwrite a newer authorization attempt', async () => {
    const { id, state } = await setup()
    let reject!: (error: Error) => void
    fetchMock.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const first = completeLinearSetup(state, 'first-code')
    expect(publicLinearIntegration(id).authorizationState).toBe('pending')
    await expect(completeLinearSetup(state, 'duplicate-code')).rejects.toThrow('already used')
    failLinearSetup(state, 'duplicate cancellation')
    expect(publicLinearIntegration(id).authorizationState).toBe('pending')
    const next = await authorizeLinearSetup(id, {})
    reject(new Error('exchange failed'))
    await expect(first).rejects.toThrow('exchange failed')
    expect(publicLinearIntegration(id).authorizationState).toBe('pending')
    expect(getLinearConfig(id).authorizationError).toBeUndefined()
    await completeLinearSetup(new URL(next).searchParams.get('state')!, 'next-code')
    expect(publicLinearIntegration(id).authorized).toBe(true)
  })
  it.each(['request', 'refresh'])('requires reconnect when %s authorization is revoked', async operation => {
    const { id, state } = await setup(); await completeLinearSetup(state, 'code')
    if (operation === 'refresh') updateLinearConfig(id, config => ({ ...config, tokens: { ...config.tokens!, expiresAt: 1 } }))
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    await expect(new LinearClient(id).identity()).rejects.toThrow()
    expect(getLinearConfig(id).tokens).toBeUndefined()
    expect(toPublicAgentIntegration(getChatIntegration(id)!)).toMatchObject({ reconnectRequired: true, hasCredentials: false })
  })

  it('retries a concurrent config write without overwriting the newer settings', async () => {
    const { id } = await setup()
    let raced = false
    updateLinearConfig(id, config => {
      if (!raced) {
        raced = true
        // Simulate another writer after the outer read, before its conditional update.
        updateLinearConfig(id, latest => ({ ...latest, runOnStatusChange: true }))
      }
      return { ...config, authorizationVersion: 'outer-update' }
    })
    expect(getLinearConfig(id)).toMatchObject({ runOnStatusChange: true, authorizationVersion: 'outer-update' })
  })

  it.each(['offline', 'server-error', 'malformed-config'])('deletes local setup even when revocation fails: %s', async failure => {
    const { id, state } = await setup()
    await completeLinearSetup(state, 'code')
    if (failure === 'malformed-config') sqlite.prepare('UPDATE chat_integrations SET config = ? WHERE id = ?').run('{bad', id)
    fetchMock.mockImplementation(async () => {
      if (failure === 'offline') throw new Error('Offline')
      return new Response(null, { status: 503 })
    })
    await expect(deleteLinearSetup(id)).resolves.toBeUndefined()
    expect(getChatIntegration(id)).toBeNull()
  })

  it('authorizes and updates a healthy integration despite a malformed sibling config', async () => {
    const { id, state } = await setup()
    const sibling = await createLinearSetup('another-agent', 'Damaged', 'owner', 'http://localhost:47897')
    sqlite.prepare('UPDATE chat_integrations SET config = ? WHERE id = ?').run('{bad', sibling.id)
    await expect(completeLinearSetup(state, 'code')).resolves.toBe(id)
    updateLinearConfig(id, config => ({ ...config, runOnStatusChange: true }))
    expect(getLinearConfig(id)).toMatchObject({ runOnStatusChange: true, identity: { appUserId: 'app-user' } })
  })

})

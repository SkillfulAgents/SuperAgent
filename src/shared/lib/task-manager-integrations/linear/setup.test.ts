vi.mock('../../services/connection-sync-service', () => ({ syncRemoteMcpAgents: vi.fn(async () => true) }))
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AppDatabase } from '../../db/drivers/types'
import { sql } from 'drizzle-orm'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
const relayEndpoints = vi.hoisted(() => ({
  create: vi.fn(async (_scope: string, _spec: { name: string }) => ({ id: `whep_${relayEndpoints.create.mock.calls.length}`, url: `https://relay.test/v1/hooks/whep_${relayEndpoints.create.mock.calls.length}` })),
  disable: vi.fn(async (_scope: string, _id: string) => {}),
}))
vi.mock('../../webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../webhook-relay')>()),
  getWebhookRelay: () => ({ createEndpoint: relayEndpoints.create, disableEndpoint: relayEndpoints.disable }),
}))
import { authorizeLinearSetup, completeLinearSetup, deleteLinearSetup, failLinearSetup, publicLinearIntegration } from './setup'
import { getLinearConfig, updateLinearConfig } from './store'
import * as linearStore from './store'
import { toPublicAgentIntegration } from '../../agent-integrations/serialization'
import { LinearClient } from './client'
import { z } from 'zod'
import { createAgentIntegration, getAgentIntegration } from '../../services/agent-integration-service'
import { integrationSetupContext, prepareIntegrationSetup } from '../../agent-integrations/setup'
async function createLinearSetup(agentSlug: string, name: string, userId: string, origin: string, input: Record<string, unknown> = {}) {
  const prepared = await prepareIntegrationSetup('linear', input, integrationSetupContext('linear', origin, agentSlug, userId))
  const id = await createAgentIntegration({ agentSlug, provider: 'linear', name, createdByUserId: userId, config: prepared.config, status: prepared.status })
  return publicLinearIntegration((await getAgentIntegration(id))!)
}
const scopes = 'read write app:mentionable app:assignable'
const identity = { id: 'app-user', app: true, name: 'Helper', displayName: 'Helper', avatarUrl: null, organization: { id: 'workspace', name: 'Team' } }
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(async () => {
  handle = await createTestDatabase(); testDb = handle.db
  vi.clearAllMocks()
  fetchMock = vi.fn(async (url: string) => Response.json(url.endsWith('/oauth/token')
    ? { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 86400, scope: scopes }
    : { data: { viewer: identity } }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(async () => { vi.restoreAllMocks(); await handle.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
async function setup(agentSlug = 'agent') {
  const integration = await createLinearSetup(agentSlug, 'Helper', 'owner', 'http://localhost:47897')
  const url = await authorizeLinearSetup(integration.id, { clientId: 'client', clientSecret: 'client-secret' })
  return { id: integration.id, state: new URL(url).searchParams.get('state')! }
}
describe('Linear relay transport setup', () => {
  it('prefills a relay app with webhooks on, the relay URL, and the resource types it reads', async () => {
    const integration = await createLinearSetup('agent', 'Helper', 'owner', 'http://localhost:47897', { transport: 'relay' })

    const url = new URL(integration.setup.creationUrl)
    expect(url.searchParams.get('webhook.enabled')).toBe('true')
    expect(url.searchParams.get('webhook.url')).toBe('https://relay.test/v1/hooks/whep_1')
    expect(url.searchParams.getAll('webhook.resourceTypes')).toEqual(['AppUserNotification', 'Comment', 'Issue'])
    expect(integration).toMatchObject({ transport: 'relay', webhook: { url: 'https://relay.test/v1/hooks/whep_1', secretSaved: false } })
  })

  it('needs the webhook signing secret before authorizing, and never shows it', async () => {
    const integration = await createLinearSetup('agent', 'Helper', 'owner', 'http://localhost:47897', { transport: 'relay' })

    await expect(authorizeLinearSetup(integration.id, { clientId: 'client', clientSecret: 'client-secret' })).rejects.toThrow('signing secret')
    await authorizeLinearSetup(integration.id, { clientId: 'client', clientSecret: 'client-secret', webhookSecret: 'signing-secret' })

    expect((await getLinearConfig(integration.id)).webhookSecret).toBe('signing-secret')
    const row = (await getAgentIntegration(integration.id))!
    expect(publicLinearIntegration(row).webhook?.secretSaved).toBe(true)
    expect(JSON.stringify(toPublicAgentIntegration(row))).not.toContain('signing-secret')
    // A retry with the saved credentials keeps the saved secret.
    await expect(authorizeLinearSetup(integration.id, {})).resolves.toContain('linear.app/oauth/authorize')
  })

  it('switches an existing installation between transports and asks for a reconnect', async () => {
    const integration = await createLinearSetup('agent', 'Helper', 'owner', 'http://localhost:47897')
    const { linearProvider } = await import('./provider')

    expect(await linearProvider.updateSettings!((await getAgentIntegration(integration.id))!, { settings: { transport: 'relay', webhookSecret: 'signing-secret' } })).toEqual({ reconnect: true })
    expect(await getLinearConfig(integration.id)).toMatchObject({ transport: 'relay', relay: { endpointId: 'whep_1' }, webhookSecret: 'signing-secret' })

    expect(await linearProvider.updateSettings!((await getAgentIntegration(integration.id))!, { settings: { transport: 'direct' } })).toEqual({ reconnect: true })
    const direct = await getLinearConfig(integration.id)
    expect(direct).toMatchObject({ transport: 'direct' })
    expect(direct.relay).toBeUndefined()
    expect(direct.webhookSecret).toBeUndefined()
    expect(relayEndpoints.disable).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'whep_1')

    expect(await linearProvider.updateSettings!((await getAgentIntegration(integration.id))!, { settings: { runOnStatusChange: true } })).toEqual({ reconnect: false })
  })
})

describe('Linear identity lifecycle', () => {
  it('uses the configured HTTPS callback behind a TLS-terminating proxy', async () => {
    vi.stubEnv('HOST_PUBLIC_URL', 'https://dev.example:8443/')
    const integration = await createLinearSetup('agent', 'Helper', 'owner', 'http://dev.example:8443')
    expect(integration.setup.redirectUri).toBe('https://dev.example:8443/api/agent-integrations/providers/linear/callback')
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
    expect((await getAgentIntegration(id))?.status).toBe('disconnected')
    expect(await completeLinearSetup(state, 'code')).toBe(id)
    expect((await getAgentIntegration(id))?.status).toBe('active')
    expect((await getLinearConfig(id)).identity).toMatchObject({ appUserId: 'app-user', workspaceId: 'workspace' })
    await expect(completeLinearSetup(state, 'code')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('expired') })
    const publicIntegration = toPublicAgentIntegration((await getAgentIntegration(id))!)
    expect(publicIntegration).toMatchObject({ provider: 'linear', hasCredentials: true, refreshIntervalMs: 30000, capabilities: [], managementAccess: 'owner', linear: { authorized: true } })
    const output = JSON.stringify(publicIntegration)
    for (const secret of ['access-secret', 'refresh-secret', 'client-secret', 'signing-secret']) expect(output).not.toContain(secret)
    const body = fetchMock.mock.calls[0][1] as RequestInit
    expect(String(body.body)).toContain('code_verifier=')
  })
  it('rejects expired state, personal tokens, and a shared app identity', async () => {
    const first = await setup()
    await updateLinearConfig(first.id, config => ({ ...config, oauth: { ...config.oauth!, expiresAt: 1 } }))
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
    expect((await getLinearConfig(duplicate.id)).tokens).toBeUndefined()
  })
  it('does not let cancellation overwrite a concurrent replacement OAuth attempt', async () => {
    const { id, state } = await setup()
    const [, replacement] = await Promise.all([failLinearSetup(state, 'cancelled'), authorizeLinearSetup(id, {})])
    const nextState = new URL(replacement).searchParams.get('state')!
    expect(publicLinearIntegration((await getAgentIntegration(id))!).authorizationState).toBe('pending')
    await expect(completeLinearSetup(nextState, 'code')).resolves.toBe(id)
  })
  it('renews once for concurrent API requests and preserves changed settings', async () => {
    const { id, state } = await setup(); await completeLinearSetup(state, 'code')
    await updateLinearConfig(id, config => ({ ...config, tokens: { ...config.tokens!, expiresAt: 1 } }))
    fetchMock.mockClear()
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/token')) {
        await updateLinearConfig(id, config => ({ ...config, runOnStatusChange: true }))
        return Response.json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 86400, scope: scopes })
      }
      return Response.json({ data: { ok: true } })
    })
    const client = new LinearClient(id)
    await Promise.all([client.request('query{ok}', {}, z.object({ ok: z.boolean() })), client.request('query{ok}', {}, z.object({ ok: z.boolean() }))])
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/oauth/token'))).toHaveLength(1)
    expect(await getLinearConfig(id)).toMatchObject({ runOnStatusChange: true, tokens: { refreshToken: 'rotated' } })
  })
  it('reads one credential snapshot per GraphQL call and keeps revocation tied to it', async () => {
    const { id, state } = await setup(); await completeLinearSetup(state, 'code')
    const read = vi.spyOn(linearStore, 'getLinearConfig')
    await new LinearClient(id).identity()
    expect(read).toHaveBeenCalledTimes(1)
    read.mockClear()
    fetchMock.mockImplementation(async () => {
      // Even if the provider returns the same access token, a new authorization
      // generation must survive an old request's 401.
      await updateLinearConfig(id, config => ({ ...config, authorizationVersion: 'replacement' }))
      return new Response(null, { status: 401 })
    })
    await expect(new LinearClient(id).identity()).rejects.toThrow('401')
    expect(read).toHaveBeenCalledTimes(1)
    expect(await getLinearConfig(id)).toMatchObject({ authorizationVersion: 'replacement', tokens: { accessToken: 'access-secret' } })
    expect((await getAgentIntegration(id))?.status).toBe('active')
  })
  it('does not overwrite a new authorization generation during token renewal', async () => {
    const { id, state } = await setup(); await completeLinearSetup(state, 'code')
    await updateLinearConfig(id, config => ({ ...config, tokens: { ...config.tokens!, expiresAt: 1 } }))
    fetchMock.mockImplementation(async () => {
      await updateLinearConfig(id, config => ({ ...config, authorizationVersion: 'replacement' }))
      return Response.json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 86400, scope: scopes })
    })
    await expect(new LinearClient(id).identity()).rejects.toThrow('changed during renewal')
    expect(await getLinearConfig(id)).toMatchObject({ authorizationVersion: 'replacement', tokens: { accessToken: 'access-secret' } })
  })
  it('does not resurrect tokens revoked while renewal is in flight', async () => {
    const { id, state } = await setup(); await completeLinearSetup(state, 'code')
    await updateLinearConfig(id, config => ({ ...config, tokens: { ...config.tokens!, expiresAt: 1 } }))
    fetchMock.mockImplementation(async () => {
      await updateLinearConfig(id, config => ({ ...config, tokens: undefined }))
      return Response.json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 86400, scope: scopes })
    })
    await expect(new LinearClient(id).identity()).rejects.toThrow('changed during renewal')
    expect((await getLinearConfig(id)).tokens).toBeUndefined()
  })
  it('revokes authorization before deleting local state', async () => {
    const { id, state } = await setup(); await completeLinearSetup(state, 'code')
    fetchMock.mockClear(); fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    await deleteLinearSetup(id)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.linear.app/oauth/revoke')
    expect(await getAgentIntegration(id)).toBeNull()
  })
  it('exposes failed and expired attempts as reconnect needed and retries with saved credentials', async () => {
    const { id, state } = await setup()
    const normal = fetchMock.getMockImplementation()!
    fetchMock.mockResolvedValueOnce(new Response('private provider error', { status: 400 }))
    await expect(completeLinearSetup(state, 'bad-code')).rejects.toThrow('authorization failed')
    expect(toPublicAgentIntegration((await getAgentIntegration(id))!)).toMatchObject({ reconnectRequired: true, hasCredentials: false,
      linear: { authorizationState: 'reconnect_needed', canReconnect: true } })
    expect(JSON.stringify(publicLinearIntegration((await getAgentIntegration(id))!))).not.toContain('private provider error')
    const retry = await authorizeLinearSetup(id, {})
    const retryState = new URL(retry).searchParams.get('state')!
    expect(retryState).not.toBe(state)
    expect(publicLinearIntegration((await getAgentIntegration(id))!).authorizationState).toBe('pending')
    await failLinearSetup(state, 'stale failure')
    await expect(completeLinearSetup(state, 'old-code')).rejects.toThrow('expired')
    expect(publicLinearIntegration((await getAgentIntegration(id))!).authorizationState).toBe('pending')
    await updateLinearConfig(id, config => ({ ...config, oauth: { ...config.oauth!, expiresAt: 1 } }))
    expect(publicLinearIntegration((await getAgentIntegration(id))!)).toMatchObject({ authorizationState: 'reconnect_needed', authorizationMessage: expect.stringContaining('expired') })
    const next = await authorizeLinearSetup(id, {})
    fetchMock.mockImplementation(normal)
    await completeLinearSetup(new URL(next).searchParams.get('state')!, 'good-code')
    expect(toPublicAgentIntegration((await getAgentIntegration(id))!)).toMatchObject({ reconnectRequired: false, hasCredentials: true,
      linear: { authorizationState: 'connected', authorizationMessage: null } })
  })
  it('does not let a stale in-flight failure overwrite a newer authorization attempt', async () => {
    const { id, state } = await setup()
    let reject!: (error: Error) => void
    fetchMock.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const first = completeLinearSetup(state, 'first-code')
    expect(publicLinearIntegration((await getAgentIntegration(id))!).authorizationState).toBe('pending')
    await expect(completeLinearSetup(state, 'duplicate-code')).rejects.toThrow('already used')
    await failLinearSetup(state, 'duplicate cancellation')
    expect(publicLinearIntegration((await getAgentIntegration(id))!).authorizationState).toBe('pending')
    const next = await authorizeLinearSetup(id, {})
    reject(new Error('exchange failed'))
    await expect(first).rejects.toThrow('exchange failed')
    expect(publicLinearIntegration((await getAgentIntegration(id))!).authorizationState).toBe('pending')
    expect((await getLinearConfig(id)).authorizationError).toBeUndefined()
    await completeLinearSetup(new URL(next).searchParams.get('state')!, 'next-code')
    expect(publicLinearIntegration((await getAgentIntegration(id))!).authorized).toBe(true)
  })
  it.each(['request', 'refresh'])('requires reconnect when %s authorization is revoked', async operation => {
    const { id, state } = await setup(); await completeLinearSetup(state, 'code')
    if (operation === 'refresh') await updateLinearConfig(id, config => ({ ...config, tokens: { ...config.tokens!, expiresAt: 1 } }))
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    await expect(new LinearClient(id).identity()).rejects.toThrow()
    expect((await getLinearConfig(id)).tokens).toBeUndefined()
    expect(toPublicAgentIntegration((await getAgentIntegration(id))!)).toMatchObject({ reconnectRequired: true, hasCredentials: false })
  })

  it('retries a concurrent config write without overwriting the newer settings', async () => {
    const { id } = await setup()
    await Promise.all([
      updateLinearConfig(id, config => ({ ...config, runOnStatusChange: true })),
      updateLinearConfig(id, config => ({ ...config, authorizationVersion: 'outer-update' })),
    ])
    expect(await getLinearConfig(id)).toMatchObject({ runOnStatusChange: true, authorizationVersion: 'outer-update' })
  })

  it.each(['offline', 'server-error', 'malformed-config'])('deletes local setup even when revocation fails: %s', async failure => {
    const { id, state } = await setup()
    await completeLinearSetup(state, 'code')
    if (failure === 'malformed-config') await testDb.run(sql`UPDATE chat_integrations SET config = ${'{bad'} WHERE id = ${id}`)
    fetchMock.mockImplementation(async () => {
      if (failure === 'offline') throw new Error('Offline')
      return new Response(null, { status: 503 })
    })
    await expect(deleteLinearSetup(id)).resolves.toBeUndefined()
    expect(await getAgentIntegration(id)).toBeNull()
  })

  it('authorizes and updates a healthy integration despite a malformed sibling config', async () => {
    const { id, state } = await setup()
    const sibling = await createLinearSetup('another-agent', 'Damaged', 'owner', 'http://localhost:47897')
    await testDb.run(sql`UPDATE chat_integrations SET config = ${'{bad'} WHERE id = ${sibling.id}`)
    await expect(completeLinearSetup(state, 'code')).resolves.toBe(id)
    await updateLinearConfig(id, config => ({ ...config, runOnStatusChange: true }))
    expect(await getLinearConfig(id)).toMatchObject({ runOnStatusChange: true, identity: { appUserId: 'app-user' } })
  })

})

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AppDatabase } from '../../db/drivers/types'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
const relay = vi.hoisted(() => ({ updateEndpoint: vi.fn(async () => ({})) }))
vi.mock('../../webhook-relay', () => ({ getWebhookRelay: () => relay }))
import { createAgentIntegration, getAgentIntegration } from '../../services/agent-integration-service'
import { githubSetup } from './setup'
import { readGitHubIntegration, updateGitHubConfig } from './store'
import { githubProvider } from './provider'
import { configured, appIdentity, privateKey } from './test-fixtures'

const context = { agentSlug: 'agent', callbackUrl: configured.redirectUri }
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
beforeEach(async () => {
  handle = await createTestDatabase(); testDb = handle.db; vi.clearAllMocks()
  fetchMock = vi.fn<typeof fetch>(async input => {
    const url = String(input)
    if (url.includes('/app-manifests/')) return Response.json({ id: 123, slug: 'release-helper', name: 'Release Helper', owner: { id: 2, login: 'team' }, pem: privateKey, webhook_secret: appIdentity.webhookSecret })
    if (url.endsWith('/app/installations/456')) return Response.json({ id: 456, app_id: 123, account: { id: 2, login: 'team' }, suspended_at: null, permissions: { contents: 'write', issues: 'write', pull_requests: 'write' } })
    if (url.includes('/users/')) return Response.json({ id: 9, login: 'release-helper[bot]', type: 'Bot' })
    throw new Error(`Unexpected test request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(async () => { await handle.close(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function start() {
  const prepared = await githubSetup.prepare({ organization: 'team' }, context)
  const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'github', name: 'Helper', status: prepared.status, config: { ...prepared.config, relay: configured.relay } })
  const row = (await getAgentIntegration(id))!
  const { url } = await githubSetup.authorize!.run(row, {}, context)
  return { id, state: new URL(url).searchParams.get('state')! }
}
async function manifest(state: string) { return githubSetup.callback!({ state, code: 'valid-code' }) }
async function install(state: string, id = '456') { return githubSetup.callback!({ state, parameters: { installation_id: id, setup_action: 'install' } }) }

it('sends an agent that set it up to authorize_agent_integration, naming the organization', async () => {
  const prepared = await githubSetup.prepare({ organization: 'team' }, context)
  const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'github', name: 'Helper', status: prepared.status, config: prepared.config })
  const step = githubSetup.agentNextStep!((await getAgentIntegration(id))!)
  expect(step).toContain(`authorize_agent_integration with integration_id "${id}"`)
  expect(step).toContain('for the team organization')
})

it('creates a private manifest with this integration’s relay, then validates and installs its bot', async () => {
  const { id, state } = await start()
  const form = await githubSetup.launch!(state)
  expect(form.url).toContain('https://github.com/organizations/team/settings/apps/new')
  expect(JSON.parse(form.fields.manifest)).toMatchObject({ public: false, hook_attributes: { url: configured.relay!.url, active: true },
    default_permissions: { contents: 'write', issues: 'write', pull_requests: 'write' }, redirect_url: context.callbackUrl })
  expect(await manifest(state)).toEqual({ redirectUrl: `https://github.com/apps/release-helper/installations/new?state=${encodeURIComponent(state)}` })
  expect(await install(state)).toEqual({ integrationId: id })
  expect((await readGitHubIntegration(id)).config).toMatchObject({ app: appIdentity, installation: configured.installation })
  expect(relay.updateEndpoint).toHaveBeenCalledWith('member', 'endpoint', expect.objectContaining({ verification: expect.objectContaining({ header: 'x-hub-signature-256', secret: appIdentity.webhookSecret }) }))
  const serialized = githubProvider.serialize!((await getAgentIntegration(id))!)
  expect(serialized.hasCredentials).toBe(true)
  for (const secret of [privateKey, appIdentity.webhookSecret, state]) expect(JSON.stringify(serialized)).not.toContain(secret)
  await expect(install(state)).rejects.toThrow('already used')
})
it('rejects expired, replaced and simultaneously replayed attempts before another conversion', async () => {
  const { id, state } = await start()
  const results = await Promise.allSettled([manifest(state), manifest(state)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await updateGitHubConfig(id, config => ({ ...config, pending: { ...config.pending!, expiresAt: 1 } }))
  await expect(install(state)).rejects.toThrow('expired')
  await githubSetup.authorize!.run((await getAgentIntegration(id))!, {}, context)
  await expect(install(state)).rejects.toThrow('expired')
})
it('rejects an installation for another app or account', async () => {
  const { state } = await start(); await manifest(state)
  fetchMock.mockResolvedValueOnce(Response.json({ id: 456, app_id: 999, account: { id: 2, login: 'team' }, suspended_at: null, permissions: {} }))
  await expect(install(state)).rejects.toThrow('owns this GitHub App')
  expect(relay.updateEndpoint).not.toHaveBeenCalled()
})
it('requires write permissions and allows retrying installation without creating another app', async () => {
  const { id, state } = await start(); await manifest(state)
  fetchMock.mockResolvedValueOnce(Response.json({ id: 456, app_id: 123, account: { id: 2, login: 'team' }, suspended_at: null, permissions: { contents: 'read' } }))
  await expect(install(state)).rejects.toThrow('write permissions')
  const { url } = await githubSetup.authorize!.run((await getAgentIntegration(id))!, {}, context)
  expect(url).toContain('/apps/release-helper/installations/new')
  expect(await install(new URL(url).searchParams.get('state')!)).toEqual({ integrationId: id })
})
it('does not put the same app identity on two agents', async () => {
  const first = await start(); await manifest(first.state)
  const second = await start()
  await expect(manifest(second.state)).rejects.toThrow('already belongs')
  expect((await readGitHubIntegration(second.id)).config.app).toBeUndefined()
})
it('keeps a newer attempt when an old conversion completes', async () => {
  const { id, state } = await start()
  let release!: (response: Response) => void
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const completion = manifest(state)
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
  const newer = await githubSetup.authorize!.run((await getAgentIntegration(id))!, {}, context)
  release(Response.json({ id: 123, slug: 'release-helper', name: 'Helper', owner: { id: 2, login: 'team' }, pem: privateKey, webhook_secret: appIdentity.webhookSecret }))
  await expect(completion).rejects.toThrow('expired')
  expect((await readGitHubIntegration(id)).config.app).toBeUndefined()
  expect(await githubSetup.launch!(new URL(newer.url).searchParams.get('state')!)).toHaveProperty('fields')
})
it('can reconnect after uninstall/reinstall changes the installation ID', async () => {
  const { id, state } = await start(); await manifest(state); await install(state)
  const { url } = await githubSetup.authorize!.run((await getAgentIntegration(id))!, {}, context)
  fetchMock.mockResolvedValueOnce(Response.json({ id: 789, app_id: 123, account: { id: 2, login: 'team' }, suspended_at: null, permissions: { contents: 'write', issues: 'write', pull_requests: 'write' } }))
  expect(await install(new URL(url).searchParams.get('state')!, '789')).toEqual({ integrationId: id })
  expect((await readGitHubIntegration(id)).config.installation?.id).toBe(789)
})

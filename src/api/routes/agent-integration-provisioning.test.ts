/**
 * One-click agent apps through the generic setup host: a test integration
 * provider and a test-only directory that can create its apps go through
 * describe → create → authorize → callback → rename → delete exactly as Slack
 * and its directory do. Nothing here is Slack.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('@shared/lib/auth/secret', () => ({ getOrCreateAuthSecret: async () => 'provisioning-route-test-secret' }))
const runtime = vi.hoisted(() => ({ add: vi.fn(async (_id: string) => {}), resume: vi.fn(async (_id: string) => {}), pause: vi.fn(async (_id: string) => {}) }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: {
  addIntegration: runtime.add, removeIntegration: vi.fn(), pauseIntegration: runtime.pause, resumeIntegration: runtime.resume, integrationCreated: vi.fn(), isIntegrationConnected: () => false, integrationTransport: () => null,
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
vi.mock('@shared/lib/services/webhook-trigger-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/services/webhook-trigger-service')>()),
  resolvePlatformMemberForCandidates: async () => ({ userId: 'owner', memberId: 'sub_owner' }),
}))
const relay = vi.hoisted(() => ({
  create: vi.fn(async (_scope: string, spec: { name: string }) => ({ id: `whep_${relay.create.mock.calls.length}`, url: `https://relay.test/v1/hooks/whep_${relay.create.mock.calls.length}`, name: spec.name, status: 'active' })),
  update: vi.fn(async (_scope: string, _id: string, _patch: unknown) => {}),
  disable: vi.fn(async (_scope: string, _id: string) => {}),
}))
vi.mock('@shared/lib/webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/webhook-relay')>()),
  getWebhookRelay: () => ({ createEndpoint: relay.create, updateEndpoint: relay.update, disableEndpoint: relay.disable, register: vi.fn() }),
}))

import { agentIntegrationRegistry } from '@shared/lib/agent-integrations/registry'
import { getAgentIntegration, listAgentIntegrations } from '@shared/lib/services/agent-integration-service'
import { registerDirectoryProvider } from '@shared/lib/team-directory/registry'
import { saveDirectoryConnection } from '@shared/lib/team-directory/store'
import { connectProvisioning, rotateProvisioning } from '@shared/lib/team-directory/provisioning'
import { createFakeDirectoryProvider, type FakeDirectory } from '@shared/lib/team-directory/testing/fake-directory-provider'
import router from './agent-integrations'

// An integration provider whose installations wait, disconnected, on webhooks for their app.
agentIntegrationRegistry.register({
  definition: { provider: 'test-app', name: 'Test App', family: 'task-manager', capabilities: [], settings: [], setup: { kind: 'test', credentialFields: [] }, transports: ['direct', 'relay'] },
  policy: { isAllowed: async () => true, sessionPolicy: () => ({ name: 'Test', metadata: {} }) },
  create: async () => { throw new Error('not needed') },
  serialize: row => ({ ...row, config: undefined, settings: {}, hasCredentials: false }),
  configuration: { identityPaths: ['$.botToken'], uniqueKey: input => (input as { botToken?: string }).botToken ?? null, merge: stored => JSON.parse(stored) },
  setup: { prepare: async input => {
    const { webhooks, ...config } = input as Record<string, unknown>
    return { config, status: 'disconnected' as const, relay: webhooks === true }
  } },
})

const app = new Hono().route('/api/agent-integrations', router)
const headers = { 'Content-Type': 'application/json' }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')
let fake: FakeDirectory
let unregister: () => void
let directoryId: string

const provisionInput = (extra: Record<string, unknown> = {}) => ({ directoryId, name: 'Support Desk', description: 'Answers support', backgroundColor: '#123456', icon: PNG, ...extra })
const create = (config: Record<string, unknown>) =>
  app.request('/api/agent-integrations/agents/agent', { method: 'POST', headers, body: JSON.stringify({ provider: 'test-app', name: 'Support Desk', config }) })
const storedConfig = async (id: string) => JSON.parse((await getAgentIntegration(id))!.config)
const ops = () => fake.provisioner.calls.map((call) => call.op)

beforeEach(async () => {
  vi.clearAllMocks()
  handle = await createTestDatabase()
  testDb = handle.db
  vi.stubEnv('HOST_PUBLIC_URL', 'https://public.example/')
  fake = createFakeDirectoryProvider('fake', 'Fake Directory', { provisionFor: 'test-app' })
  unregister = registerDirectoryProvider(fake.provider)
  directoryId = (await saveDirectoryConnection({ provider: 'fake', tenant: { tenantId: 'acme', tenantName: 'Acme' }, credentials: { token: 'acme-token' }, createdByUserId: null })).id
  await connectProvisioning(directoryId, { key: 'admin-key' })
})
afterEach(async () => {
  unregister()
  await handle.close()
  vi.unstubAllEnvs()
})

describe('one-click agent apps', () => {
  it('offers the directory in setup only while it can create apps', async () => {
    const setup = async () => (await app.request('/api/agent-integrations/agents/agent/providers/test-app/setup')).json()
    expect(await setup()).toMatchObject({ provisioning: { directoryId, workspace: 'Acme' } })
    fake.provisioner.failRotation('broken')
    await rotateProvisioning(directoryId, { force: true })
    expect(await setup()).not.toHaveProperty('provisioning')
  })

  it('creates the app with the webhook URL, signs the endpoint with its secret, and waits for the install', async () => {
    const response = await create({ webhooks: true, provision: provisionInput() })
    expect(response.status).toBe(201)
    const created = await response.json()

    expect(fake.provisioner.calls.find((call) => call.op === 'create')?.detail).toMatchObject({
      name: 'Support Desk', description: 'Answers support', backgroundColor: '#123456', icon: 11,
      webhookUrl: 'https://relay.test/v1/hooks/whep_1',
      redirectUrl: 'https://public.example/api/agent-integrations/providers/test-app/callback',
    })
    expect(relay.update).toHaveBeenCalledWith('sub_owner', 'whep_1', { verification: expect.objectContaining({ secret: 'signing-APP1' }) })
    expect(await storedConfig(created.id)).toMatchObject({
      signingSecret: 'signing-APP1',
      relay: { endpointId: 'whep_1' },
      provisionedApp: { directoryId, app: { appId: 'APP1' }, installed: false, iconSet: true, name: 'Support Desk' },
    })
    expect(created.status).toBe('disconnected')
    expect(runtime.add).not.toHaveBeenCalled()
    // The client sees the app, never its secrets.
    expect(created.provisionedApp).toEqual({ directoryId, installed: false, name: 'Support Desk', iconSet: true, settingsUrl: 'https://provider.test/apps/APP1' })
    expect(JSON.stringify(created)).not.toContain('secret-APP1')
  })

  it('installs with one approval, and the callback connects it once', async () => {
    const { id } = await (await create({ webhooks: true, provision: provisionInput() })).json()
    const { url } = await (await app.request(`/api/agent-integrations/${id}/authorize`, { method: 'POST', headers, body: '{}' })).json()
    const install = new URL(url)
    expect(install.origin + install.pathname).toBe('https://provider.test/install')
    expect(install.searchParams.get('redirect_uri')).toBe('https://public.example/api/agent-integrations/providers/test-app/callback')
    const state = install.searchParams.get('state')!

    const callback = await app.request(`/api/agent-integrations/providers/test-app/callback?state=${state}&code=granted`)
    expect(await callback.text()).toContain('Account connected')
    expect(runtime.resume).toHaveBeenCalledWith(id)
    expect(await storedConfig(id)).toMatchObject({ botToken: 'token-APP1-granted', provisionedApp: { installed: true } })
    expect((await getAgentIntegration(id))?.status).toBe('active')

    // The state is spent: a replay installs nothing.
    const replay = await app.request(`/api/agent-integrations/providers/test-app/callback?state=${state}&code=again`)
    expect(replay.status).toBe(400)
    expect(ops().filter((op) => op === 'install')).toHaveLength(1)
    // Installed apps don't install again.
    expect((await app.request(`/api/agent-integrations/${id}/authorize`, { method: 'POST', headers, body: '{}' })).status).toBe(409)
  })

  it('leaves the installation waiting when the person declines the install', async () => {
    const { id } = await (await create({ webhooks: true, provision: provisionInput() })).json()
    const state = new URL((await (await app.request(`/api/agent-integrations/${id}/authorize`, { method: 'POST', headers, body: '{}' })).json()).url).searchParams.get('state')
    const declined = await app.request(`/api/agent-integrations/providers/test-app/callback?state=${state}&error=access_denied`)
    expect(await declined.text()).toContain('Authorization cancelled')
    expect((await getAgentIntegration(id))?.status).toBe('disconnected')
  })

  it('renames the app and gives it a new icon from the integration page', async () => {
    const { id } = await (await create({ webhooks: true, provision: provisionInput({ icon: undefined }) })).json()
    const response = await app.request(`/api/agent-integrations/${id}/app`, { method: 'POST', headers, body: JSON.stringify({ name: 'Help Desk', icon: PNG }) })
    expect(response.status).toBe(200)
    expect(fake.provisioner.calls.at(-1)).toEqual({ op: 'update', detail: { appId: 'APP1', name: 'Help Desk', icon: 11 } })
    expect((await response.json()).provisionedApp).toMatchObject({ name: 'Help Desk', iconSet: true })

    const notPng = await app.request(`/api/agent-integrations/${id}/app`, { method: 'POST', headers, body: JSON.stringify({ icon: Buffer.from('<svg/>').toString('base64') }) })
    expect(notPng.status).toBe(400)
  })

  it('deletes the app with the installation', async () => {
    const { id } = await (await create({ webhooks: true, provision: provisionInput() })).json()
    expect((await app.request(`/api/agent-integrations/${id}`, { method: 'DELETE' })).status).toBeLessThan(300)
    expect(fake.provisioner.calls.at(-1)).toEqual({ op: 'delete', detail: { appId: 'APP1' } })
  })

  it('undoes the endpoint when the app can’t be created, and creates no installation', async () => {
    fake.provisioner.failCreate(new Error('provider refused'))
    const response = await create({ webhooks: true, provision: provisionInput() })
    expect(response.status).toBe(500)
    expect(relay.disable).toHaveBeenCalledWith('sub_owner', 'whep_1')
    expect(await listAgentIntegrations()).toEqual([])
  })

  it('needs webhooks, and refuses an icon that isn’t a PNG before anything is created', async () => {
    expect((await create({ provision: provisionInput() })).status).toBe(400)
    expect((await create({ webhooks: true, provision: provisionInput({ icon: Buffer.from('GIF89a').toString('base64') }) })).status).toBe(400)
    expect(ops()).not.toContain('create')
    expect(await listAgentIntegrations()).toEqual([])
  })

  it('leaves an installation set up by hand alone: nothing to install, rename or delete', async () => {
    const { id } = await (await create({ webhooks: true })).json()
    expect((await create({ webhooks: true, botToken: 'other' })).status).toBe(201)
    const rename = await app.request(`/api/agent-integrations/${id}/app`, { method: 'POST', headers, body: JSON.stringify({ name: 'X' }) })
    expect(rename.status).toBe(400)
    await app.request(`/api/agent-integrations/${id}`, { method: 'DELETE' })
    expect(ops()).toEqual([])
  })
})

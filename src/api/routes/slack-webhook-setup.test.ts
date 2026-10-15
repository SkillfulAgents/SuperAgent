import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
const runtime = vi.hoisted(() => ({ add: vi.fn(async (_id: string) => {}), remove: vi.fn(async (_id: string) => {}), resume: vi.fn(async (_id: string) => {}) }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: {
  addIntegration: runtime.add, removeIntegration: runtime.remove, pauseIntegration: vi.fn(), resumeIntegration: runtime.resume, integrationCreated: vi.fn(), isIntegrationConnected: () => false, integrationTransport: () => null,
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
  resolvePlatformMemberForCandidates: async (candidates: string[]) => candidates.includes('owner') ? { userId: 'owner', memberId: 'sub_owner' } : null,
}))
const relay = vi.hoisted(() => ({
  create: vi.fn(async (_scope: string, spec: { name: string }) => ({ id: `whep_${relay.create.mock.calls.length}`, url: `https://relay.test/v1/hooks/whep_${relay.create.mock.calls.length}`, name: spec.name, status: 'active' })),
  update: vi.fn(async (_scope: string, id: string, _changes: unknown) => ({ id, url: `https://relay.test/v1/hooks/${id}`, name: 'Slack', status: 'active' })),
  disable: vi.fn(async (_scope: string, _id: string) => {}),
}))
vi.mock('@shared/lib/webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/webhook-relay')>()),
  getWebhookRelay: () => ({ createEndpoint: relay.create, updateEndpoint: relay.update, disableEndpoint: relay.disable, register: vi.fn() }),
}))
import { sql } from 'drizzle-orm'
import { getAgentIntegration } from '@shared/lib/services/agent-integration-service'
import { slackVerificationProfile } from '@shared/lib/chat-integrations/slack-webhooks'
import router from './agent-integrations'

const app = new Hono().route('/api/agent-integrations', router)
const headers = { Authorization: 'user-token', 'Content-Type': 'application/json' }
const create = (config: Record<string, unknown>) =>
  app.request('/api/agent-integrations/agents/agent', { method: 'POST', headers, body: JSON.stringify({ provider: 'slack', name: 'Helper', config }) })
const patch = (id: string, body: Record<string, unknown>) =>
  app.request(`/api/agent-integrations/${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
async function stored(id: string) {
  const row = (await getAgentIntegration(id))!
  return { status: row.status, config: JSON.parse(row.config) }
}

const slackApi = vi.hoisted(() => ({ authTest: { ok: true } as Record<string, unknown> }))
beforeEach(async () => {
  vi.clearAllMocks(); handle = await createTestDatabase(); testDb = handle.db
  vi.stubEnv('HOST_PUBLIC_URL', 'https://public.example/')
  slackApi.authTest = { ok: true }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(slackApi.authTest)))
})
afterEach(async () => { await handle.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('creates a Slack installation with its webhook URL before the app exists, then connects it with the app’s credentials', async () => {
  const created = await create({ webhooks: true, onlyMentioned: true })
  expect(created.status).toBe(201)
  const row = await created.json()
  // Nothing to connect yet; the URL goes into the app's manifest.
  expect(runtime.add).not.toHaveBeenCalled()
  expect(row).toMatchObject({ status: 'disconnected', hasCredentials: false, slack: { botTokenSaved: false, webhook: { url: 'https://relay.test/v1/hooks/whep_1', status: 'pending' } } })
  expect(relay.create).toHaveBeenCalledExactlyOnceWith('sub_owner', { name: 'Slack integration for agent' })

  const finished = await patch(row.id, { config: { botToken: 'xoxb-1', signingSecret: 'signing-secret' }, status: 'active' })
  expect(finished.status).toBe(200)
  expect(relay.update).toHaveBeenCalledExactlyOnceWith('sub_owner', 'whep_1', { verification: slackVerificationProfile('signing-secret') })
  expect(runtime.resume).toHaveBeenCalledWith(row.id)
  expect((await stored(row.id)).config).toMatchObject({ botToken: 'xoxb-1', signingSecret: 'signing-secret', onlyMentioned: true, relay: { endpointId: 'whep_1' } })
  expect(await finished.json()).toMatchObject({ hasCredentials: true, slack: { botTokenSaved: true, signingSecretSaved: true } })
})

it('keeps a waiting installation as it was when its bot token is mistyped', async () => {
  const row = await (await create({ webhooks: true })).json()
  slackApi.authTest = { ok: false, error: 'invalid_auth' }
  const typo = await patch(row.id, { config: { botToken: 'xoxb-typo', signingSecret: 'signing-secret' }, status: 'active' })
  expect(typo.status).toBe(400)
  expect((await typo.json()).error).toBe('Bot token invalid: invalid_auth')
  expect(runtime.resume).not.toHaveBeenCalled()
  expect(await stored(row.id)).toMatchObject({ status: 'disconnected', config: { relay: { endpointId: 'whep_1' } } })
  expect((await stored(row.id)).config).not.toHaveProperty('botToken')
})

it('mints the endpoint checking Slack’s signatures when the app’s credentials come with the create', async () => {
  const created = await create({ webhooks: true, botToken: 'xoxb-1', signingSecret: 'signing-secret' })
  expect(created.status).toBe(201)
  expect(relay.create).toHaveBeenCalledExactlyOnceWith('sub_owner', { name: 'Slack integration for agent', verification: slackVerificationProfile('signing-secret') })
  expect(runtime.add).toHaveBeenCalled()
})

it('still pauses a Slack row whose config it can’t read', async () => {
  const row = await (await create({ botToken: 'xoxb-1', appToken: 'xapp-1' })).json()
  await testDb.run(sql`update chat_integrations set config = '{"onlyMentioned":true}' where id = ${row.id}`)
  expect((await patch(row.id, { status: 'paused' })).status).toBe(200)
})

it('sets webhooks up on a Socket Mode installation, and removes them again', async () => {
  const row = await (await create({ botToken: 'xoxb-1', appToken: 'xapp-1' })).json()
  expect(relay.create).not.toHaveBeenCalled()

  const setUp = await patch(row.id, { settings: { webhooks: true }, config: { signingSecret: 'signing-secret' } })
  expect(setUp.status).toBe(200)
  // Minted under the installation's creator, whom this test's create didn't record.
  expect(relay.create).toHaveBeenCalledExactlyOnceWith(expect.any(String), { name: 'Slack integration for agent', verification: slackVerificationProfile('signing-secret') })
  expect(runtime.add).toHaveBeenLastCalledWith(row.id)
  expect((await setUp.json()).slack).toEqual({ botTokenSaved: true, appTokenSaved: true, signingSecretSaved: true, webhook: { url: 'https://relay.test/v1/hooks/whep_1', status: 'pending' } })

  const again = await patch(row.id, { settings: { webhooks: true } })
  expect(again.status).toBe(200)
  expect(relay.create).toHaveBeenCalledOnce()

  const removed = await patch(row.id, { settings: { webhooks: false } })
  expect(removed.status).toBe(200)
  expect(relay.disable).toHaveBeenCalledWith(expect.any(String), 'whep_1')
  expect((await stored(row.id)).config).toEqual({ botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: 'signing-secret' })
})

it('explains what is missing instead of setting webhooks up or removing them', async () => {
  const socket = await (await create({ botToken: 'xoxb-1', appToken: 'xapp-1' })).json()
  const noSecret = await patch(socket.id, { settings: { webhooks: true } })
  expect(noSecret.status).toBe(400)
  expect((await noSecret.json()).error).toMatch(/signing secret/)

  const webhookOnly = await (await create({ webhooks: true, botToken: 'xoxb-2', signingSecret: 'secret' })).json()
  const noAppToken = await patch(webhookOnly.id, { settings: { webhooks: false } })
  expect(noAppToken.status).toBe(400)
  expect((await noAppToken.json()).error).toMatch(/app-level token/)
  expect(relay.disable).not.toHaveBeenCalled()

  // Supplied with the removal, the token is what the installation receives with afterwards.
  const withToken = await patch(webhookOnly.id, { settings: { webhooks: false }, config: { appToken: 'xapp-2' } })
  expect(withToken.status).toBe(200)
  expect((await stored(webhookOnly.id)).config).toEqual({ botToken: 'xoxb-2', signingSecret: 'secret', appToken: 'xapp-2' })
})

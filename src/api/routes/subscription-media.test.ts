import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { llmConnections, user } from '@shared/lib/db/schema'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { SubscriptionMediaProvider } from '@shared/lib/subscription-media'
import { CredentialRefreshError } from '../../../agent-container/src/credential-refresh-error'

const state = vi.hoisted(() => ({
  db: null as TestDatabase['db'] | null,
  owner: null as string | null,
  providers: [] as SubscriptionMediaProvider[],
}))
vi.mock('@shared/lib/db', () => ({
  get db() {
    return state.db
  },
}))
vi.mock('@shared/lib/services/agent-owner', () => ({
  getAgentOwnerUserId: async () => state.owner,
}))
vi.mock('@shared/lib/subscription-media/registry', () => ({
  get SUBSCRIPTION_MEDIA_PROVIDERS() {
    return state.providers
  },
}))
vi.mock('@shared/lib/llm-provider/connection-credentials', () => ({
  resolveConnectionCredential: async (id: string) => {
    if (id === 'expired') throw new CredentialRefreshError(401)
    return { accessToken: `token-for-${id}`, generation: 1, expiresAt: Date.now() + 60_000, refreshToken: 'refresh' }
  },
}))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('../middleware/auth', () => ({
  IsAgent: (): MiddlewareHandler => async (c, next) => {
    if (c.req.header('Authorization') !== 'Bearer agent-test-token') return c.json({ error: 'Unauthorized' }, 401)
    c.set('agentSlug' as never, 'alpha' as never)
    return next()
  },
}))
import routes from './subscription-media'
import { subscriptionMediaPrompt } from '@shared/lib/subscription-media'

const fake: SubscriptionMediaProvider = {
  id: 'codex',
  name: 'Codex',
  llmProviderId: 'codex-subscription',
  extraPrompt: 'Use Bash to POST /subscription-media/codex/image.',
  async generateImage(input, credential) {
    const { accessToken } = await credential()
    return [{ mimeType: 'image/png', base64: Buffer.from(`${accessToken}:${JSON.stringify(input)}`).toString('base64') }]
  },
}

let handle: TestDatabase
const app = new Hono().route('/media', routes)
function generate(provider = 'codex', token = 'agent-test-token') {
  return app.request(`/media/${provider}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt: 'a red square' }),
  })
}
async function addConnection(id: string, userId: string | null, createdAt: number, provider = 'codex-subscription') {
  await handle.db.insert(llmConnections).values({
    id, userId, name: id, provider, config: '{}', createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
  }).run()
}
function decoded(body: { images: { base64: string }[] }) {
  return Buffer.from(body.images[0].base64, 'base64').toString()
}

beforeEach(async () => {
  handle = await createTestDatabase()
  state.db = handle.db
  state.owner = 'owner'
  state.providers = [fake]
  for (const id of ['owner', 'coworker']) {
    await handle.db.insert(user).values({ id, name: id, email: `${id}@example.com` }).run()
  }
})
afterEach(async () => {
  await handle.close()
})

it('uses the agent owner connection before a shared one and never another user connection', async () => {
  await addConnection('coworker-codex', 'coworker', 1)
  await addConnection('shared-codex', null, 2)
  await addConnection('owner-codex', 'owner', 3)
  const response = await generate()
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(decoded(await response.json())).toBe('token-for-owner-codex:{"prompt":"a red square"}')
})

it('falls back to a shared connection, but not to another user connection', async () => {
  await addConnection('coworker-codex', 'coworker', 1)
  await addConnection('shared-codex', null, 2)
  expect(decoded(await (await generate()).json())).toContain('token-for-shared-codex')
})

it('reports a provider that is not connected for this owner', async () => {
  await addConnection('coworker-codex', 'coworker', 1)
  const response = await generate()
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'Codex is not connected. Connect it in Settings → Model Providers.' })
})

it('rejects unknown providers and unauthenticated callers', async () => {
  await addConnection('owner-codex', 'owner', 1)
  expect((await generate('grok')).status).toBe(404)
  expect((await generate('codex', 'wrong')).status).toBe(401)
})

it('returns a reconnect error when the credential cannot refresh', async () => {
  await addConnection('expired', 'owner', 1)
  const response = await generate()
  expect(response.status).toBe(401)
  expect((await response.json()).error).toContain('reconnect')
})

it('includes instructions only for providers the owner can use', async () => {
  const grok = { ...fake, id: 'grok', llmProviderId: 'grok-subscription' as const, extraPrompt: 'Grok media instructions.' }
  state.providers = [fake, grok]
  await addConnection('coworker-codex', 'coworker', 1)
  expect(await subscriptionMediaPrompt('alpha')).toBe('')
  await addConnection('shared-codex', null, 2)
  expect(await subscriptionMediaPrompt('alpha')).toBe(fake.extraPrompt)
  await addConnection('owner-codex', 'owner', 3)
  expect(await subscriptionMediaPrompt('alpha')).toBe(fake.extraPrompt)
  await addConnection('owner-grok', 'owner', 4, 'grok-subscription')
  expect(await subscriptionMediaPrompt('alpha')).toBe(`${fake.extraPrompt}\n\n${grok.extraPrompt}`)
  state.owner = null
  expect(await subscriptionMediaPrompt('alpha')).toBe(fake.extraPrompt)
  state.providers = []
  expect(await subscriptionMediaPrompt('alpha')).toBe('')
})

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
import { availableMediaProviders } from '@shared/lib/subscription-media'

const fake: SubscriptionMediaProvider = {
  id: 'codex',
  name: 'Codex',
  llmProviderId: 'codex-subscription',
  async generateImage(input, credential) {
    const { accessToken } = await credential()
    return [{ mimeType: 'image/png', base64: Buffer.from(`${accessToken}:${JSON.stringify(input)}`).toString('base64') }]
  },
  async startVideo(_input, credential) {
    return `request-for-${(await credential()).accessToken}`
  },
  async getVideo(requestId, credential) {
    return { status: 'failed', error: `${requestId} polled with ${(await credential()).accessToken}` }
  },
}

let handle: TestDatabase
const app = new Hono().route('/media', routes)
function post(path: string, body: unknown, token = 'agent-test-token') {
  return app.request(`/media/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}
function generate(provider = 'codex', token = 'agent-test-token') {
  return post(`${provider}/image`, { prompt: 'a red square' }, token)
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

it('lists only providers the owner can use', async () => {
  await addConnection('coworker-codex', 'coworker', 1)
  expect(await availableMediaProviders('alpha')).toEqual([])
  await addConnection('owner-codex', 'owner', 2)
  expect(await availableMediaProviders('alpha')).toEqual(['codex'])
  state.providers = []
  expect(await availableMediaProviders('alpha')).toEqual([])
})

it('binds a video job to the connection that started it', async () => {
  await addConnection('owner-codex', 'owner', 1)
  const started = await post('codex/video', { prompt: 'waves' })
  const { job } = await started.json()
  expect(job).toBe('owner-codex:request-for-token-for-owner-codex')
  expect(await (await post('codex/video/status', { job })).json()).toEqual({
    status: 'failed', error: 'request-for-token-for-owner-codex polled with token-for-owner-codex',
  })

  const forged = await post('codex/video/status', { job: 'coworker-codex:request-1' })
  expect(forged.status).toBe(409)
  expect((await post('codex/video/status', { job: 'no-separator' })).status).toBe(400)
})

it('rejects video for providers without video support', async () => {
  state.providers = [{ ...fake, startVideo: undefined, getVideo: undefined }]
  await addConnection('owner-codex', 'owner', 1)
  expect((await post('codex/video', { prompt: 'waves' })).status).toBe(404)
})

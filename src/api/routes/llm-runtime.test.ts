import { eq } from 'drizzle-orm'
import { llmConnections } from '@shared/lib/db/schema'
import { connectionConfigSchema } from '@shared/lib/llm-provider/connection-schema'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppSettings } from '@shared/lib/config/settings'

const state = vi.hoisted(() => ({
  db: null as TestDatabase['db'] | null,
  settings: {} as AppSettings,
  currentId: '',
}))
vi.mock('@shared/lib/db', () => ({
  get db() {
    return state.db
  },
}))
vi.mock('@shared/lib/config/settings', async (original) => ({
  ...(await original<typeof import('@shared/lib/config/settings')>()),
  getSettings: () => state.settings,
  getEffectiveModels: () => ({ agentModel: 'model', summarizerModel: 'model' }),
  mutateSettings: (change: (s: AppSettings) => void) => change(state.settings),
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => undefined,
}))
vi.mock('../middleware/auth', () => ({
  IsAgent: (): MiddlewareHandler => async (c, next) => {
    if (c.req.header('Authorization') !== 'Bearer agent-test-token')
      return c.json({ error: 'Unauthorized' }, 401)
    c.set('agentSlug' as never, 'alpha' as never)
    return next()
  },
}))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: () => ({
      sessions: {
        isKnown: async (id: string) => id === 'own-session',
        metadata: async () => ({ model: 'model', llmProviderId: state.currentId }),
      },
      config: { get: async () => ({}) },
    }),
  },
}))
import routes from './llm-runtime'
import { saveConnection, setGlobalSelection } from '@shared/lib/llm-provider/connections'
import { sessionRuntime } from '@shared/lib/llm-provider/connection-runtime'

let handle: TestDatabase
const app = new Hono().route('/runtime', routes)
function request(operation: string, body: unknown, token = 'agent-test-token') {
  return app.request(`/runtime/${operation}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
}
beforeEach(async () => {
  handle = await createTestDatabase()
  state.db = handle.db
  state.settings = { llmLegacyProviderId: 'imported' } as AppSettings
  state.currentId = await saveConnection(
    {
      name: 'Account',
      provider: 'generic',
      config: {
        apiKeys: { genericApiKey: 'static-key', genericBaseUrl: 'https://test.example' },
      },
      modelOverrides: [{ id: 'model', label: 'Test model', supportedEfforts: ['low'] }],
    },
    { userId: null, admin: true }
  )
  await setGlobalSelection('default', { llmProviderId: state.currentId, model: 'model' })
})
afterEach(async () => handle.close())

it('scopes resolution to the authenticated agent session and rejects arbitrary account nomination', async () => {
  expect((await request('resolve', { sessionId: 'own-session' }, 'wrong')).status).toBe(401)
  expect((await request('resolve', { sessionId: 'another-agent-session' })).status).toBe(404)
  expect(
    (await request('resolve', { sessionId: 'own-session', llmProviderId: 'other-account' }))
      .status
  ).toBe(409)
  const response = await request('resolve', { sessionId: 'own-session' })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toMatchObject({
    llmProviderId: state.currentId,
    model: 'model',
    env: { ANTHROPIC_AUTH_TOKEN: 'static-key' },
  })
  expect(sessionRuntime('alpha', 'own-session')?.env).toEqual({})
})


it('prewarms the authenticated agent default without accepting a nominated provider', async () => {
  expect((await request('prewarm', {}, 'wrong')).status).toBe(401)
  const res = await request('prewarm', { llmProviderId: 'other-account', model: 'other-model' })
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(await res.json()).toMatchObject({ llmProviderId: state.currentId, model: 'model' })
})


it('returns access-only proxy credentials and keeps them out of presentation metadata', async () => {
  await handle.db.update(llmConnections).set({ provider: 'grok-subscription', config: JSON.stringify(connectionConfigSchema.parse({
    oauth: { accessToken: 'private-access', refreshToken: 'never-container-refresh', expiresAt: Date.now() + 3600000 },
  })) }).where(eq(llmConnections.id, state.currentId)).run()
  const response = await request('resolve', { sessionId: 'own-session', llmProviderId: state.currentId })
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.proxy).toMatchObject({ adapter: 'grok', credential: { accessToken: 'private-access' } })
  expect(JSON.stringify(body)).not.toContain('never-container-refresh')
  expect(JSON.stringify(sessionRuntime('alpha', 'own-session'))).not.toContain('private-access')
  expect((await request('resolve', { sessionId: 'own-session', llmProviderId: 'another-account', rejectedGeneration: 0 })).status).toBe(409)
})

it('returns a non-retryable reconnect contract for a revoked subscription', async () => {
  await handle.db.update(llmConnections).set({ provider: 'grok-subscription', config: JSON.stringify(connectionConfigSchema.parse({
    oauth: { accessToken: 'revoked', refreshToken: 'revoked-refresh', expiresAt: 0,
      refreshFailure: { reconnectRequired: true, retryAt: 0 } },
  })) }).where(eq(llmConnections.id, state.currentId)).run()
  const response = await request('resolve', { sessionId: 'own-session', llmProviderId: state.currentId, rejectedGeneration: 0 })
  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ code: 'provider_reconnect_required', error: expect.stringContaining('reconnect in Settings') })
})

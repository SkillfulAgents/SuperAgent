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
        metadata: async () => ({ model: 'model', connectionId: state.currentId }),
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
  state.settings = { llmLegacyConnectionId: 'imported' } as AppSettings
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
  await setGlobalSelection('default', { connectionId: state.currentId, model: 'model' })
})
afterEach(async () => handle.close())

it('scopes resolution to the authenticated agent session and rejects arbitrary account nomination', async () => {
  expect((await request('resolve', { sessionId: 'own-session' }, 'wrong')).status).toBe(401)
  expect((await request('resolve', { sessionId: 'another-agent-session' })).status).toBe(404)
  expect(
    (await request('resolve', { sessionId: 'own-session', connectionId: 'other-account' }))
      .status
  ).toBe(409)
  const response = await request('resolve', { sessionId: 'own-session' })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toMatchObject({
    connectionId: state.currentId,
    model: 'model',
    env: { ANTHROPIC_AUTH_TOKEN: 'static-key' },
  })
  expect(sessionRuntime('alpha', 'own-session')?.env).toEqual({})
})

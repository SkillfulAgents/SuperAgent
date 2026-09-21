import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { user } from '@shared/lib/db/schema'
import type { AppSettings } from '@shared/lib/config/settings'

const state = vi.hoisted(() => ({
  db: null as TestDatabase['db'] | null,
  settings: {} as AppSettings,
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
  Authenticated: (): MiddlewareHandler => async (c, next) => {
    const id = c.req.header('Test-User')
    if (!id) return c.json({ error: 'Unauthorized' }, 401)
    c.set('user' as never, { id, role: id === 'admin' ? 'admin' : 'user' } as never)
    return next()
  },
  IsAdmin: (): MiddlewareHandler => async (c, next) =>
    c.req.header('Test-User') === 'admin' ? next() : c.json({ error: 'Forbidden' }, 403),
}))
import routes from './llm-connections'

let database: TestDatabase
const app = new Hono().route('/connections', routes)
const catalog = [{ id: 'model', label: 'Test model', supportedEfforts: ['low'] }]
function draft(userId: string | null = null) {
  return {
    name: 'Test account',
    provider: 'generic',
    userId,
    config: {
      apiKeys: { genericApiKey: 'private-api-key', genericBaseUrl: 'https://provider.example' },
    },
    modelOverrides: catalog,
  }
}
function request(path: string, method = 'GET', body?: unknown, caller = 'admin') {
  return app.request(`/connections${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Test-User': caller },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}
beforeEach(async () => {
  database = await createTestDatabase()
  state.db = database.db
  state.settings = { llmLegacyConnectionId: 'already-imported' } as AppSettings
  vi.stubEnv('AUTH_MODE', 'true')
  await database.db
    .insert(user)
    .values([
      { id: 'alice', name: 'Alice', email: 'alice@example.com' },
      { id: 'bob', name: 'Bob', email: 'bob@example.com' },
    ])
    .run()
})
afterEach(async () => {
  await database.close()
  vi.unstubAllEnvs()
})

describe('connection API ownership and root protection', () => {
  it('keeps keys private and rejects cross-owner edits, deletes and global creation', async () => {
    const created = await request('', 'POST', draft('alice'), 'alice')
    expect(created.status).toBe(201)
    const { id } = await created.json()
    const own = await (await request('', 'GET', undefined, 'alice')).json()
    expect(own.connections[0]).toMatchObject({ id, ownerName: 'Alice' })
    expect(JSON.stringify(own)).not.toContain('private-api-key')
    expect((await (await request('', 'GET', undefined, 'bob')).json()).connections).toEqual([])
    expect((await request(`/${id}`, 'PUT', draft('alice'), 'bob')).status).toBe(400)
    expect((await request(`/${id}`, 'DELETE', undefined, 'admin')).status).toBe(400)
    expect((await request('', 'POST', draft(), 'alice')).status).toBe(400)
    expect((await request('', 'POST', draft('bob'), 'alice')).status).toBe(400)
  })
  it('enforces root/catalog protection through direct HTTP mutations', async () => {
    const { id } = await (await request('', 'POST', draft())).json()
    expect(
      (await request('/defaults/default', 'PUT', { connectionId: id, model: 'model' })).status
    ).toBe(200)
    expect((await request(`/${id}`, 'DELETE')).status).toBe(400)
    expect((await request(`/${id}`, 'PUT', { ...draft(), modelOverrides: [] })).status).toBe(400)
    expect(
      (await request('/defaults/default', 'PUT', { connectionId: id, model: 'model' }, 'alice'))
        .status
    ).toBe(403)
    const { id: personal } = await (await request('', 'POST', draft('alice'), 'alice')).json()
    expect(
      (await request('/defaults/summarizer', 'PUT', { connectionId: personal, model: 'model' }))
        .status
    ).toBe(400)
  })
})

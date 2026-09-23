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
import { getConnection, saveConnection, resolveConnectionSelection } from '@shared/lib/llm-provider/connections'
import { connectionRuntime } from '@shared/lib/llm-provider/connection-runtime'

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
  state.settings = { llmLegacyProviderId: 'already-imported' } as AppSettings
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
  vi.unstubAllGlobals()
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
      (await request('/defaults/default', 'PUT', { llmProviderId: id, model: 'model' })).status
    ).toBe(200)
    expect((await request(`/${id}`, 'DELETE')).status).toBe(400)
    expect((await request(`/${id}`, 'PUT', { ...draft(), modelOverrides: [] })).status).toBe(400)
    expect(
      (await request('/defaults/default', 'PUT', { llmProviderId: id, model: 'model' }, 'alice'))
        .status
    ).toBe(403)
    const { id: personal } = await (await request('', 'POST', draft('alice'), 'alice')).json()
    expect(
      (await request('/defaults/summarizer', 'PUT', { llmProviderId: personal, model: 'model' }))
        .status
    ).toBe(400)
  })
})


it('accepts connection env without exposing values, and rejects reserved runtime overrides', async () => {
  const input = draft()
  const created = await request('', 'POST', { ...input, config: { ...input.config, runtimeEnv: { ANTHROPIC_AUTH_TOKEN: 'private-bearer' } } })
  expect(created.status).toBe(201)
  const response = await (await request('')).json()
  expect(response.connections[0].customEnvVarKeys).toEqual(['ANTHROPIC_AUTH_TOKEN'])
  expect(JSON.stringify(response)).not.toContain('private-bearer')
  for (const key of ['PROXY_TOKEN', 'PLATFORM_AUTH_TOKEN', 'SUPERAGENT_HOST_API_URL']) {
    const rejected = await request('', 'POST', { ...input, config: { ...input.config, runtimeEnv: { [key]: 'bad-override' } } })
    expect(rejected.status).toBe(400)
    expect((await rejected.json()).error).toBe('Invalid connection configuration')
  }
})


describe('connection environment permissions', () => {
  const adminOnlyEnv = {
    HTTPS_PROXY: 'http://proxy.example',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    NODE_OPTIONS: '--require=/workspace/injected.js',
    CLAUDE_CONFIG_DIR: '/workspace/alternate-config',
    PATH: '/workspace/bin',
    LD_PRELOAD: '/workspace/injected.so',
    AWS_SHARED_CREDENTIALS_FILE: '/workspace/credentials',
    CLAUDE_CODE_SHELL: '/workspace/shell',
    ANTHROPIC_FUTURE_SETTING: 'unreviewed',
    CUSTOM_PROVIDER_SECRET: 'admin-secret',
  }

  it.each(Object.entries(adminOnlyEnv))('rejects member injection of %s on create, edit and validation', async (key, value) => {
    const input = draft('alice')
    const { id } = await (await request('', 'POST', input, 'alice')).json()
    const before = await getConnection(id)
    const malicious = { ...input, config: { ...input.config, runtimeEnv: { [key]: value } } }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const [path, method, body] of [
      ['', 'POST', malicious],
      [`/${id}`, 'PUT', malicious],
      ['/validate', 'POST', { connection: malicious }],
      ['/validate', 'POST', { id, connection: malicious }],
    ] as const) {
      const response = await request(path, method, body, 'alice')
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: `Only administrators can set these environment variables: ${key}` })
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await getConnection(id)).toEqual(before)
    expect((await (await request('', 'GET', undefined, 'alice')).json()).connections).toHaveLength(1)
  })

  it('preserves member provider, AWS credentials and CLI tuning overrides through runtime resolution', async () => {
    const input = draft('alice')
    const runtimeEnv = {
      ANTHROPIC_BASE_URL: 'https://personal-proxy.example',
      ANTHROPIC_AUTH_TOKEN: 'personal-bearer',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Provider-Project: personal',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fast-model',
      AWS_ACCESS_KEY_ID: 'personal-access-key',
      AWS_SECRET_ACCESS_KEY: 'personal-secret',
      AWS_SESSION_TOKEN: 'personal-session-token',
      AWS_REGION: 'eu-west-1',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '64000',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000',
      ENABLE_TOOL_SEARCH: 'false',
    }
    const created = await request('', 'POST', { ...input, config: { ...input.config, runtimeEnv } }, 'alice')
    expect(created.status).toBe(201)
    const { id } = await created.json()
    const updated = await request(`/${id}`, 'PUT', {
      ...input, config: { runtimeEnv: { ANTHROPIC_AUTH_TOKEN: 'updated-bearer', ANTHROPIC_DEFAULT_HAIKU_MODEL: null } },
    }, 'alice')
    expect(updated.status).toBe(200)
    const selection = await resolveConnectionSelection({ llmProviderId: id, model: 'model' })
    const runtime = await connectionRuntime(selection!, 'restricted-agent')
    const expectedEnv: Record<string, string> = { ...runtimeEnv, ANTHROPIC_AUTH_TOKEN: 'updated-bearer' }
    delete expectedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL
    expect(runtime.env).toMatchObject(expectedEnv)
    expect(runtime.env).not.toHaveProperty('ANTHROPIC_DEFAULT_HAIKU_MODEL')
    const listed = await (await request('', 'GET', undefined, 'alice')).json()
    expect(JSON.stringify(listed)).not.toContain('updated-bearer')
    expect(JSON.stringify(listed)).not.toContain('personal-secret')
  })

  it('retains arbitrary custom environment variables for administrators', async () => {
    const input = draft()
    const created = await request('', 'POST', { ...input, config: { ...input.config, runtimeEnv: adminOnlyEnv } })
    expect(created.status).toBe(201)
    const { id } = await created.json()
    const selection = await resolveConnectionSelection({ llmProviderId: id, model: 'model' })
    expect((await connectionRuntime(selection!, 'agent')).env).toMatchObject(adminOnlyEnv)
    expect((await request(`/${id}`, 'PUT', { ...input, config: { runtimeEnv: { HTTPS_PROXY: 'http://updated-proxy.example' } } })).status).toBe(200)
    expect(JSON.parse((await getConnection(id))!.config).runtimeEnv.HTTPS_PROXY).toBe('http://updated-proxy.example')
  })

  it('checks retained values after role changes and lets members explicitly remove them', async () => {
    const input = draft('alice')
    const id = await saveConnection({ ...input, config: {
      ...input.config, runtimeEnv: { NODE_OPTIONS: '--require=/workspace/injected.js', ANTHROPIC_BASE_URL: 'https://personal-proxy.example' },
    } }, { userId: 'alice', admin: true })
    const before = await getConnection(id)
    const renamed = { ...input, name: 'Renamed', config: {} }
    expect((await request(`/${id}`, 'PUT', renamed, 'alice')).status).toBe(400)
    expect((await request('/validate', 'POST', { id, connection: renamed }, 'alice')).status).toBe(400)
    expect(await getConnection(id)).toEqual(before)
    expect((await request(`/${id}`, 'PUT', { ...renamed, config: { runtimeEnv: { NODE_OPTIONS: null } } }, 'alice')).status).toBe(200)
    expect(JSON.parse((await getConnection(id))!.config).runtimeEnv).toEqual({ ANTHROPIC_BASE_URL: 'https://personal-proxy.example' })
  })
})

it('stores subscription tokens privately, preserves/replaces them, and enforces helper and auth isolation', async () => {
  const subscription = { name: 'Claude plan', provider: 'claude-subscription', userId: null,
    config: { apiKeys: { claudeSubscriptionToken: 'sk-ant-oat01-test-subscription' } } }
  const created = await request('', 'POST', subscription)
  expect(created.status).toBe(201)
  const { id } = await created.json()
  const publicResponse = await (await request('')).json()
  expect(JSON.stringify(publicResponse)).not.toContain('sk-ant-oat01-test-subscription')
  expect(publicResponse.connections[0]).toMatchObject({ supportsDirectApi: false, isConfigured: true })
  expect((await request('/defaults/summarizer', 'PUT', { llmProviderId: id, model: 'sonnet' })).status).toBe(400)
  expect((await request('/defaults/default', 'PUT', { llmProviderId: id, model: 'sonnet' })).status).toBe(400)
  const { id: api } = await (await request('', 'POST', draft())).json()
  expect((await request('/defaults/summarizer', 'PUT', { llmProviderId: api, model: 'model' })).status).toBe(200)
  expect((await request('/defaults/default', 'PUT', { llmProviderId: id, model: 'sonnet' })).status).toBe(200)
  expect((await request('/defaults/summarizer', 'PUT', null)).status).toBe(400)
  expect((await request(`/${api}`, 'DELETE')).status).toBe(400)
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']) {
    const response = await request(`/${id}`, 'PUT', { ...subscription, config: { runtimeEnv: { [key]: 'conflicting' } } })
    expect(response.status).toBe(400)
  }
  expect((await request(`/${id}`, 'PUT', { ...subscription, config: { runtimeEnv: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096' } } })).status).toBe(200)
  const first = await connectionRuntime((await resolveConnectionSelection({ llmProviderId: id, model: 'sonnet' }))!, 'agent')
  expect(first.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-subscription', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096' })
  expect((await request(`/${id}`, 'PUT', { ...subscription, config: { apiKeys: { claudeSubscriptionToken: 'sk-ant-oat01-replacement' } } })).status).toBe(200)
  const next = await connectionRuntime((await resolveConnectionSelection({ llmProviderId: id, model: 'sonnet' }))!, 'agent')
  expect(next.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-replacement')
  expect(next.generation).toBeGreaterThan(first.generation)
  const apiRuntime = await connectionRuntime((await resolveConnectionSelection({ llmProviderId: api, model: 'model' }))!, 'agent')
  expect(apiRuntime.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
  expect(JSON.stringify(apiRuntime)).not.toContain('sk-ant-oat01')
  const invalid = await request('', 'POST', { ...subscription, config: { apiKeys: { claudeSubscriptionToken: 'not-a-token' } } })
  expect(invalid.status).toBe(400)
  expect(JSON.stringify(await invalid.json())).not.toContain('not-a-token')
})

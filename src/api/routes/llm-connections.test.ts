import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { eq } from 'drizzle-orm'
import { user, llmConnections } from '@shared/lib/db/schema'
import type { AppSettings } from '@shared/lib/config/settings'

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  db: null as TestDatabase['db'] | null,
  settings: {} as AppSettings,
}))
vi.mock('@shared/lib/llm-provider/grok-oauth', () => ({
  refreshGrokCredential: state.refresh,
  startGrokLogin: async () => ({ device: { device_code: 'private-device', user_code: 'CODE', verification_uri: 'https://accounts.x.ai', expires_in: 1800, interval: 5 }, endpoints: { token_endpoint: 'https://auth.x.ai/token' } }),
  pollGrokLogin: async () => ({ credential: { accessToken: 'private-oauth-access', refreshToken: 'private-oauth-refresh', expiresAt: Date.now() + 3600000, accountLabel: 'Alice Grok' } }),
}))
vi.mock('@shared/lib/llm-provider/codex-oauth', () => ({
  startCodexLogin: async () => ({ device: { device_code: 'private-codex-device', user_code: 'CODE', verification_uri: 'https://auth.openai.com/codex/device', expires_in: 900, interval: 5 }, endpoints: { token_endpoint: 'https://auth.openai.com/oauth/token' } }),
  pollCodexLogin: async () => ({ credential: { accessToken: 'private-codex-access', refreshToken: 'private-codex-refresh', expiresAt: Date.now() + 3600000, accountId: 'account', accountLabel: 'Alice Codex' } }),
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
vi.mock('@shared/lib/agent-actor', () => ({
  containerHost: { getReadiness: () => ({ status: 'READY' }), hasRunningAgents: () => false },
}))
vi.mock('@shared/lib/startup', () => ({ getServicesInitError: () => null }))
import runtimeStatusRoutes from './runtime-status'
import routes from './llm-connections'
import llmRoutes from './llm'
import { getConnection, saveConnection, resolveConnectionSelection } from '@shared/lib/llm-provider/connections'
import { connectionRuntime } from '@shared/lib/llm-provider/connection-runtime'

let database: TestDatabase
const app = new Hono().route('/connections', routes).route('/llm', llmRoutes).route('/runtime-status', runtimeStatusRoutes)
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
  it('keeps runtime key status on the selected connection when its saved model retires', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const created = await request('', 'POST', draft())
    expect(created.status).toBe(201)
    const { id } = await created.json()
    state.settings.llmDefault = { llmProviderId: id, model: 'retired-model' }

    const response = await app.request('/runtime-status', { headers: { 'Test-User': 'admin' } })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ apiKeyConfigured: true })
  })

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

it('publishes the resolved fallback when the saved summarizer model has retired', async () => {
  const id = await saveConnection({ name: 'API', provider: 'anthropic', config: { apiKeys: { anthropicApiKey: 'test-key' } } }, { admin: true, userId: null })
  state.settings.llmSummarizer = { llmProviderId: id, model: 'claude-retired-model' }
  const res = await request('')
  expect(res.status).toBe(200)
  expect((await res.json()).summarizerSelection).toEqual({ llmProviderId: id, model: 'haiku' })
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


it('accepts future setup-token versions without requiring an app update', async () => {
  const response = await request('', 'POST', {
    name: 'Future Claude token', provider: 'claude-subscription',
    config: { apiKeys: { claudeSubscriptionToken: 'sk-ant-oat02-future-token' } },
  })
  expect(response.status).toBe(201)
})

describe('subscription credentials require a subscription provider', () => {
  it.each(['anthropic', 'openrouter', 'generic', 'bedrock'])('rejects OAuth env on %s during save and validation', async provider => {
    const input = { ...draft(), provider, config: { runtimeEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'private-subscription-token' } } }
    for (const [path, body] of [['', input], ['/validate', { connection: input }]] as const) {
      const response = await request(path, 'POST', body)
      expect(response.status).toBe(400)
      const { error } = await response.json()
      expect(error).toContain('Subscription tokens require a Claude Subscription provider')
      expect(error).not.toContain('private-subscription-token')
    }
  })

  it.each(['runtimeEnv', 'env'])('checks retained %s bindings and allows explicitly removing them', async field => {
    const input = { name: 'API', provider: 'anthropic', config: { apiKeys: { anthropicApiKey: 'test-key' } } }
    const { id } = await (await request('', 'POST', input)).json()
    const saved = (await getConnection(id))!
    const config = JSON.parse(saved.config)
    config[field].CLAUDE_CODE_OAUTH_TOKEN = 'legacy-subscription-token'
    await database.db.update(llmConnections).set({ config: JSON.stringify(config) }).where(eq(llmConnections.id, id)).run()
    const renamed = { ...input, name: 'Renamed', config: {} }
    expect((await request(`/${id}`, 'PUT', renamed)).status).toBe(400)
    expect((await request('/validate', 'POST', { id, connection: renamed })).status).toBe(400)
    expect((await request(`/${id}`, 'PUT', { ...renamed, config: { runtimeEnv: { CLAUDE_CODE_OAUTH_TOKEN: null } } })).status).toBe(200)
  })

  it('rejects the connection-only credential field on an API provider too', async () => {
    const response = await request('', 'POST', {
      name: 'API', provider: 'anthropic', config: { apiKeys: { claudeSubscriptionToken: 'sk-ant-oat01-test-token' } },
    })
    expect(response.status).toBe(400)
  })
})

it('routes dashboard shim requests to the API summarizer when the app default is a subscription', async () => {
  const { id: api } = await (await request('', 'POST', draft())).json()
  expect((await request('/defaults/default', 'PUT', { llmProviderId: api, model: 'model' })).status).toBe(200)
  const { id: subscription } = await (await request('', 'POST', {
    name: 'Claude plan', provider: 'claude-subscription',
    config: { apiKeys: { claudeSubscriptionToken: 'sk-ant-oat01-test-subscription' } },
  })).json()
  expect((await request('/defaults/default', 'PUT', { llmProviderId: subscription, model: 'sonnet' })).status).toBe(200)
  const config = await app.request('/llm/config', { headers: { 'Test-User': 'admin' } })
  expect(await config.json()).toMatchObject({ configured: true, provider: 'generic', defaultModel: 'model' })
  const sent: Request[] = []
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    sent.push(new Request(input, init))
    return Response.json({ id: 'test-message', type: 'message', content: [{ type: 'text', text: 'OK' }] })
  })
  vi.stubGlobal('fetch', fetchMock)
  for (const model of [undefined, 'explicit-dashboard-model']) {
    const response = await app.request('/llm/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Test-User': 'admin' },
      body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: 'Hello' }] }),
    })
    expect(response.status).toBe(200)
    const upstream = sent.at(-1)!
    expect(upstream.url).toBe('https://provider.example/v1/messages')
    expect(upstream.headers.get('authorization')).toBe('Bearer private-api-key')
    expect(await upstream.json()).toMatchObject({ model: model ?? 'model' })
  }
  expect(fetchMock).toHaveBeenCalledTimes(2)
})


it('binds OAuth grants to the initiating owner and never returns subscription credentials', async () => {
  expect((await request('/oauth/grok/start', 'POST', { userId: null }, 'alice')).status).toBe(400)
  const started = await request('/oauth/grok/start', 'POST', { userId: 'alice' }, 'alice')
  expect(started.status).toBe(200)
  const login = await started.json()
  expect(JSON.stringify(login)).not.toContain('private-device')
  expect((await request(`/oauth/${login.id}/poll`, 'POST', {}, 'bob')).status).toBe(400)
  const polled = await request(`/oauth/${login.id}/poll`, 'POST', {}, 'alice')
  expect(await polled.json()).toEqual({ status: 'connected', accountLabel: 'Alice Grok' })
  const draft = { name: 'Grok', provider: 'grok-subscription', userId: 'alice', oauthLoginId: login.id, config: {} }
  const saved = await request('', 'POST', draft, 'alice')
  expect(saved.status).toBe(201)
  const { id } = await saved.json()
  const row = (await getConnection(id))!
  expect(JSON.parse(row.config).oauth.refreshToken).toBe('private-oauth-refresh')
  const listed = await request('', 'GET', undefined, 'alice')
  const publicData = JSON.stringify(await listed.json())
  expect(publicData).toContain('Alice Grok')
  expect(publicData).not.toContain('private-oauth')
  expect((await request('', 'POST', draft, 'alice')).status).toBe(400)
})

it('preserves the rotated credential pair when a name edit lands during refresh', async () => {
  const { resolveConnectionCredential } = await import('@shared/lib/llm-provider/connection-credentials')
  const { connectionConfigSchema } = await import('@shared/lib/llm-provider/connection-schema')
  const fresh = { accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresAt: Date.now() + 3600000 }
  await database.db.insert(llmConnections).values({ id: 'refresh-edit', provider: 'grok-subscription', name: 'Old name',
    config: JSON.stringify(connectionConfigSchema.parse({ oauth: { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 0 } })), createdAt: new Date(), updatedAt: new Date() }).run()
  let release!: (value: typeof fresh) => void
  let began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  state.refresh.mockImplementation(() => { began(); return new Promise(resolve => { release = resolve }) })
  const refreshing = resolveConnectionCredential('refresh-edit')
  await started
  const editing = request('/refresh-edit', 'PUT', { name: 'New name', provider: 'grok-subscription', userId: null, config: {} })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect((await getConnection('refresh-edit'))?.name).toBe('Old name')
  release(fresh)
  await refreshing
  expect((await editing).status).toBe(200)
  const saved = await getConnection('refresh-edit')
  expect(saved?.name).toBe('New name')
  expect(connectionConfigSchema.parse(JSON.parse(saved!.config)).oauth).toEqual(fresh)
})

it('binds Codex grants to their provider and keeps dashboard helpers on the API provider', async () => {
  const { id: api } = await (await request('', 'POST', draft())).json()
  await request('/defaults/default', 'PUT', { llmProviderId: api, model: 'model' })
  const login = await (await request('/oauth/codex/start', 'POST', { userId: null })).json()
  expect((await request(`/oauth/${login.id}/poll`, 'POST', {})).status).toBe(200)
  const connection = { name: 'Codex', provider: 'codex-subscription', userId: null, oauthLoginId: login.id, config: {} }
  expect((await request('', 'POST', { ...connection, provider: 'grok-subscription' })).status).toBe(400)
  const saved = await request('', 'POST', connection)
  expect(saved.status).toBe(201)
  const { id } = await saved.json()
  expect((await request('/defaults/default', 'PUT', { llmProviderId: id, model: 'gpt' })).status).toBe(200)
  expect((await request('/defaults/summarizer', 'PUT', { llmProviderId: id, model: 'gpt' })).status).toBe(400)
  const config = await app.request('/llm/config', { headers: { 'Test-User': 'admin' } })
  expect(await config.json()).toMatchObject({ configured: true, provider: 'generic', defaultModel: 'model' })
  const publicData = JSON.stringify(await (await request('', 'GET')).json())
  expect(publicData).toContain('Alice Codex')
  expect(publicData).not.toContain('private-codex')
})

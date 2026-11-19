vi.mock('@shared/lib/services/session-activity', () => ({
  recordSessionActivity: vi.fn(),
  recordProvisionalSessionActivity: (_store: unknown, _id: string, at: number) => ({ recordedAtMs: at, previousMs: null }),
  revertSessionActivity: vi.fn(),
}))
vi.mock('@shared/lib/agent-integrations/mcp', () => ({ integrationMcpProjection: vi.fn(async () => []) }))
import { mockChatIntegration } from '@shared/lib/chat-integrations/test-helpers'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as path from 'path'
import * as schema from '@shared/lib/db/schema'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('@shared/lib/db', () => ({
  get db() { return testDb },
}))

const mockEnsureRunning = vi.fn()

// The actor reaches the container client through getClient after start();
// hand back whatever ensureRunning last resolved to.
let mockClient: unknown
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      ensureRunning: async (...args: unknown[]) => {
        mockClient = await mockEnsureRunning(...args)
        return mockClient
      },
      getClient: () => mockClient,
    }),
  }
})

const mockValidateProxyToken = vi.fn()

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...args: unknown[]) => mockValidateProxyToken(...args),
}))

const mockGetChatIntegration = vi.fn()
const mockCreateChatIntegration = vi.fn()
const mockListChatIntegrations = vi.fn()
const mockUpdateAgentIntegrationStatus = vi.fn()

const MockDuplicateIntegrationIdentityError = vi.hoisted(() => class DuplicateIntegrationIdentityError extends Error {})

vi.mock('@shared/lib/services/agent-integration-service', () => ({
  getAgentIntegration: (...args: unknown[]) => mockGetChatIntegration(...args),
  createAgentIntegration: (...args: unknown[]) => mockCreateChatIntegration(...args),
  listAgentIntegrations: (...args: unknown[]) => mockListChatIntegrations(...args),
  updateAgentIntegrationStatus: (...args: unknown[]) => mockUpdateAgentIntegrationStatus(...args),
  DuplicateIntegrationIdentityError: MockDuplicateIntegrationIdentityError,
}))

const mockListActiveAgentIntegrationSessions = vi.fn()
const mockGetAgentIntegrationSessionBySessionId = vi.fn()

vi.mock('@shared/lib/services/agent-integration-session-service', () => ({
  listActiveAgentIntegrationSessions: (...args: unknown[]) => mockListActiveAgentIntegrationSessions(...args),
  getAgentIntegrationSessionBySessionId: (...args: unknown[]) => mockGetAgentIntegrationSessionBySessionId(...args),
}))

const mockAddIntegration = vi.fn()
const mockGetConnector = vi.fn()
const mockGetActiveIntegrationIds = vi.fn()
const mockEnsureSession = vi.fn()
const mockGetConnectorClass = vi.fn()

const mockPauseIntegration = vi.fn()
const mockResumeIntegration = vi.fn()

vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({
  agentIntegrationManager: {
    addIntegration: (...args: unknown[]) => mockAddIntegration(...args),
    pauseIntegration: (...args: unknown[]) => mockPauseIntegration(...args),
    resumeIntegration: (...args: unknown[]) => mockResumeIntegration(...args),
    getConnector: (...args: unknown[]) => {
      const transport = mockGetConnector(...args)
      return transport ? mockChatIntegration(transport) : undefined
    },
    getActiveIntegrationIds: (...args: unknown[]) => mockGetActiveIntegrationIds(...args),
    ensureSession: (...args: unknown[]) => mockEnsureSession(...args),
    getDefinition: (...args: unknown[]) => mockGetConnectorClass(...args),
    integrationCreated: vi.fn(),
  },
}))

const mockValidateChatIntegrationConfig = vi.fn()

vi.mock('@shared/lib/chat-integrations/config-schema', async importOriginal => ({
  ...await importOriginal<typeof import('@shared/lib/chat-integrations/config-schema')>(),
  validateChatIntegrationConfig: (...args: unknown[]) => mockValidateChatIntegrationConfig(...args),
  CHAT_PROVIDERS: ['slack', 'telegram', 'imessage'],
  IMESSAGE_GATEWAY_URL: 'https://imessage-gateway.example.com',
}))

// The agent's workspace on this machine; the transcript append lands below it.
vi.mock('@shared/lib/utils/file-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/utils/file-storage')>()),
  getAgentWorkspaceDir: () => '/tmp/superagent/agent-one',
}))

const mockCaptureException = vi.fn()

// A host with a webhook relay and a team directory that creates apps, when a test turns them on.
const setupHost = vi.hoisted(() => ({ relay: false, directory: null as { directoryId: string; workspace: string } | null }))
vi.mock('@shared/lib/webhook-relay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/webhook-relay')>()
  return { ...actual, getWebhookRelay: () => setupHost.relay ? { snapshot: () => ({ available: true }) } : actual.getWebhookRelay() }
})
vi.mock('@shared/lib/team-directory/provisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/team-directory/provisioning')>()),
  findProvisioner: async () => setupHost.directory,
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

const mockExistsSync = vi.fn()
const mockAppendFile = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  promises: {
    appendFile: (...args: unknown[]) => mockAppendFile(...args),
    mkdir: vi.fn(),
    // No session metadata yet: the delivery reads none.
    readFile: vi.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
  },
}))

import xAgentChat from './x-agent-chat'
import { chatDefinitions } from '@shared/lib/chat-integrations/definitions'
import { agentIntegrationRegistry } from '@shared/lib/agent-integrations/registry'
import { agentRegistry } from '@shared/lib/agent-actor'
import { answerSetupRequests } from '@shared/lib/agent-integrations/setup-request'
import type { AgentIntegrationRecord } from '@shared/lib/agent-integrations/types'
import { z } from 'zod'

const FIXED_TIME = new Date('2026-11-03T12:00:00Z')

function createApp() {
  const app = new Hono()
  app.route('/api/x-agent/chat', xAgentChat)
  return app
}

function createIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'integration-1',
    agentSlug: 'agent-one',
    provider: 'slack',
    name: 'Team Slack',
    status: 'connected',
    ...overrides,
  }
}

function immediateTimeout() {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0]) => {
    if (typeof handler === 'function') handler()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
}

describe('x-agent chat route', () => {
  let app: ReturnType<typeof createApp>
  let connector: {
    startWorking: ReturnType<typeof vi.fn>
    stopWorking: ReturnType<typeof vi.fn>
    sendMessage: ReturnType<typeof vi.fn>
  }
  let containerSendMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Set up real in-memory DB so isChatAllowed exercises genuine SQL.
    // Seed 'integration-1' as slack (requireApproval=false) → isChatAllowed returns
    // true for all default-path tests without any access row needed.
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    const now = Date.now()
    testSqlite
      .prepare(
        `INSERT INTO chat_integrations (id, agent_slug, provider, config, require_approval, created_at, updated_at)
         VALUES ('integration-1', 'agent-one', 'slack', '{}', 0, ?, ?)`,
      )
      .run(now, now)

    vi.clearAllMocks()
    app = createApp()
    connector = {
      startWorking: vi.fn().mockResolvedValue(undefined),
      stopWorking: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    }
    containerSendMessage = vi.fn().mockResolvedValue(undefined)

    mockValidateProxyToken.mockResolvedValue('agent-one')
    mockGetChatIntegration.mockReturnValue(createIntegration())
    mockListChatIntegrations.mockReturnValue([createIntegration()])
    mockListActiveAgentIntegrationSessions.mockReturnValue([
      { externalChatId: 'chat-1', displayName: 'General', archivedAt: null, updatedAt: FIXED_TIME, createdAt: FIXED_TIME },
    ])
    mockGetAgentIntegrationSessionBySessionId.mockReturnValue(null)
    mockGetConnector.mockReturnValue(connector)
    mockGetConnectorClass.mockResolvedValue(undefined)
    mockGetActiveIntegrationIds.mockReturnValue(['integration-1'])
    mockEnsureSession.mockResolvedValue('session-1')
    mockEnsureRunning.mockResolvedValue({
      sendMessage: containerSendMessage,
      subscribeToStream: vi.fn(() => ({ unsubscribe: vi.fn(), ready: Promise.resolve() })),
    })
    mockAppendFile.mockResolvedValue(undefined)
    mockExistsSync.mockReturnValue(false)
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    testSqlite?.close()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('rejects requests without a valid proxy token', async () => {
    mockValidateProxyToken.mockResolvedValue(null)

    const res = await app.request('http://localhost/api/x-agent/chat/list', {
      method: 'POST',
      headers: { Authorization: 'Bearer bad-token' },
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('stores the exchanged iMessage token rather than the single-use setup code', async () => {
    const fetch = vi.fn(async () => Response.json({ token: 'issued-token' }))
    vi.stubGlobal('fetch', fetch)
    mockCreateChatIntegration.mockResolvedValue('created-imessage')
    mockGetChatIntegration.mockResolvedValue(createIntegration({ id: 'created-imessage', provider: 'imessage', status: 'active' }))
    const response = await app.request('/api/x-agent/chat/add', {
      method: 'POST', headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'imessage', name: 'Agent phone', config: { phoneNumber: '+15555550100', code: '123456' } }),
    })
    expect(response.status).toBe(201)
    expect(mockCreateChatIntegration).toHaveBeenCalledExactlyOnceWith({
      agentSlug: 'agent-one', provider: 'imessage', name: 'Agent phone', status: undefined,
      config: { phoneNumber: '+15555550100', token: 'issued-token', gatewayUrl: 'https://imessage-gateway.example.com' },
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(mockAddIntegration).toHaveBeenCalledExactlyOnceWith('created-imessage')
  })

  it("records the agent's first owner as the creator of an integration the agent adds", async () => {
    vi.stubEnv('AUTH_MODE', 'true')
    try {
      for (const [id, email] of [['user-dana', 'dana@example.com'], ['user-lee', 'lee@example.com']]) {
        testSqlite.prepare('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)').run(id, id, email)
      }
      const acl = testSqlite.prepare('INSERT INTO agent_acl (id, user_id, agent_slug, role, created_at) VALUES (?, ?, ?, ?, ?)')
      acl.run('acl-2', 'user-lee', 'agent-one', 'owner', 2000)
      acl.run('acl-1', 'user-dana', 'agent-one', 'owner', 1000)
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ token: 'issued-token' })))
      mockCreateChatIntegration.mockResolvedValue('created-imessage')
      mockGetChatIntegration.mockResolvedValue(createIntegration({ id: 'created-imessage', provider: 'imessage', status: 'active' }))

      const response = await app.request('/api/x-agent/chat/add', {
        method: 'POST', headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'imessage', config: { phoneNumber: '+15555550100', code: '123456' } }),
      })

      expect(response.status).toBe(201)
      expect(mockCreateChatIntegration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentSlug: 'agent-one', createdByUserId: 'user-dana' }))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('persists a provider-prepared disconnected status without starting the runtime', async () => {
    agentIntegrationRegistry.register({
      definition: { provider: 'test-agent-setup', name: 'Test', family: 'chat', managementAccess: 'user', capabilities: [], settings: [], setup: { kind: 'credentials', credentialFields: [] } },
      policy: { isAllowed: async () => true, sessionPolicy: () => ({ name: 'Test', metadata: {} }) },
      create: async () => { throw new Error('not needed') },
      setup: { prepare: async () => ({ config: { prepared: true }, status: 'disconnected' }) },
    })
    mockCreateChatIntegration.mockResolvedValue('created-pending')
    mockGetChatIntegration.mockResolvedValue(createIntegration({ id: 'created-pending', provider: 'test-agent-setup', status: 'disconnected' }))
    const response = await app.request('/api/x-agent/chat/add', {
      method: 'POST', headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'test-agent-setup', config: { raw: true } }),
    })
    expect(response.status).toBe(201)
    expect(mockCreateChatIntegration).toHaveBeenCalledExactlyOnceWith({ agentSlug: 'agent-one', provider: 'test-agent-setup', name: undefined, config: { prepared: true }, status: 'disconnected' })
    expect(mockAddIntegration).not.toHaveBeenCalled()
    expect(await response.json()).toMatchObject({ status: 'disconnected' })
  })

  describe('a provider the agent sets up in its browser', () => {
    const provider = 'test-agent-oauth'
    const post = (route: string, body: Record<string, unknown>) => app.request(`/api/x-agent/chat/${route}`, {
      method: 'POST', headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const run = vi.fn()
    const callback = vi.fn()

    beforeEach(() => {
      run.mockResolvedValue({ url: 'https://provider.example/authorize?state=s1' })
      if (agentIntegrationRegistry.getDefinition(provider)) return
      agentIntegrationRegistry.register({
        definition: { provider, name: 'OAuth Test', family: 'task-manager', managementAccess: 'owner', capabilities: [], settings: [], setup: { kind: 'private-oauth-app', credentialFields: [] } },
        policy: { isAllowed: async () => true, sessionPolicy: () => ({ name: 'Test', metadata: {} }) },
        create: async () => { throw new Error('not needed') },
        setup: {
          agentGuide: 'Create the app in your browser, then authorize it.',
          agentNextStep: record => `Create the app for ${record.id}`,
          prepare: async (_input, context) => ({ config: { redirectUri: context.callbackUrl }, status: 'disconnected' }),
          authorize: { inputSchema: z.object({ clientId: z.string() }).strict(), run: (...args) => run(...args) },
          callback: (...args) => callback(...args),
        },
      })
    })

    it('creates the installation on the address the container calls from, with its next step', async () => {
      mockCreateChatIntegration.mockResolvedValue('oauth-1')
      mockGetChatIntegration.mockResolvedValue(createIntegration({ id: 'oauth-1', provider, status: 'disconnected' }))

      const response = await app.request('http://host.docker.internal:3000/api/x-agent/chat/add', {
        method: 'POST', headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, name: 'Bot' }),
      })

      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({ id: 'oauth-1', status: 'disconnected', nextStep: 'Create the app for oauth-1' })
      expect(mockCreateChatIntegration).toHaveBeenCalledWith(expect.objectContaining({
        provider, config: { redirectUri: `http://host.docker.internal:3000/api/agent-integrations/providers/${provider}/callback` },
      }))
      expect(mockAddIntegration).not.toHaveBeenCalled()
    })

    it('hands the agent its authorization link', async () => {
      mockGetChatIntegration.mockResolvedValue(createIntegration({ id: 'oauth-1', provider, status: 'disconnected' }))

      const response = await post('authorize', { integration_id: 'oauth-1', config: { clientId: 'client' } })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ url: 'https://provider.example/authorize?state=s1' })
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'oauth-1' }), { clientId: 'client' }, expect.objectContaining({ agentSlug: 'agent-one' }))
      expect(mockPauseIntegration).toHaveBeenCalledWith('oauth-1')
    })

    it('authorizes only the caller\'s own installations', async () => {
      mockGetChatIntegration.mockResolvedValue(createIntegration({ id: 'oauth-2', agentSlug: 'agent-two', provider }))
      expect((await post('authorize', { integration_id: 'oauth-2' })).status).toBe(404)
      expect(run).not.toHaveBeenCalled()
    })

    it('lists every provider with how the agent sets it up', async () => {
      const response = await post('providers', {})

      expect(response.status).toBe(200)
      const { providers, webhookRelay } = await response.json() as { providers: Array<{ provider: string; guide?: string; unavailable?: string }>; webhookRelay: boolean }
      expect(webhookRelay).toBe(false)
      expect(providers.find(listed => listed.provider === provider)).toEqual({ provider, name: 'OAuth Test', guide: 'Create the app in your browser, then authorize it.' })
      // Every registered provider is there: none is kept from the agent.
      expect(providers.map(listed => listed.provider).sort()).toEqual(agentIntegrationRegistry.listDefinitions().map(definition => definition.provider).sort())
      for (const listed of providers) expect(listed.guide ?? listed.unavailable).toBeTruthy()
    })

    it('marks a provider whose app the user can create in one click', async () => {
      setupHost.relay = true
      setupHost.directory = { directoryId: 'directory-1', workspace: 'Acme' }
      try {
        const { providers } = await (await post('providers', {})).json() as { providers: Array<{ provider: string; oneClickWorkspace?: string }> }
        expect(providers.find(listed => listed.provider === 'slack')?.oneClickWorkspace).toBe('Acme')
        // This one can't receive webhooks, so no directory creates its app.
        expect(providers.find(listed => listed.provider === provider)).not.toHaveProperty('oneClickWorkspace')
      } finally {
        setupHost.relay = false
        setupHost.directory = null
      }
    })

    it('completes the provider callback from the address the browser was sent to', async () => {
      mockGetChatIntegration.mockResolvedValue(createIntegration({ id: 'oauth-1', provider, status: 'active' }))
      callback.mockResolvedValue({ integrationId: 'oauth-1' })

      const response = await post('complete-authorization', {
        integration_id: 'oauth-1',
        url: `http://localhost:47891/api/agent-integrations/providers/${provider}/callback?state=s1&code=c1&installation_id=7`,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: 'active' })
      expect(callback).toHaveBeenCalledWith({ state: 's1', code: 'c1', error: undefined, parameters: { state: 's1', code: 'c1', installation_id: '7' } })
      expect(mockResumeIntegration).toHaveBeenCalledWith('oauth-1')
    })

    it('passes a further provider step back to the agent', async () => {
      mockGetChatIntegration.mockResolvedValue(createIntegration({ id: 'oauth-1', provider }))
      callback.mockResolvedValue({ redirectUrl: 'https://provider.example/install?state=s1' })

      const response = await post('complete-authorization', { integration_id: 'oauth-1', url: `http://x/api/agent-integrations/providers/${provider}/callback?state=s1&code=c1` })

      expect(await response.json()).toEqual({ status: 'continue', url: 'https://provider.example/install?state=s1' })
      expect(mockResumeIntegration).not.toHaveBeenCalled()
    })

    it('refuses addresses that are not this provider\'s callback, and another installation\'s authorization', async () => {
      mockGetChatIntegration.mockResolvedValue(createIntegration({ id: 'oauth-1', provider }))
      const notCallback = await post('complete-authorization', { integration_id: 'oauth-1', url: 'https://evil.example/steal?state=s1&code=c1' })
      expect(notCallback.status).toBe(400)
      expect(callback).not.toHaveBeenCalled()

      callback.mockResolvedValue({ integrationId: 'someone-else' })
      const other = await post('complete-authorization', { integration_id: 'oauth-1', url: `http://x/api/agent-integrations/providers/${provider}/callback?state=s2&code=c2` })
      expect(other.status).toBe(400)
      expect(mockResumeIntegration).not.toHaveBeenCalled()
    })
  })

  it('answers a setup the agent handed to the user when that provider connects', async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ success: true }))
    mockEnsureRunning.mockResolvedValue({ fetch })
    const inputs = agentRegistry.get('agent-one').inputs
    const ask = (id: string, provider: string) => inputs.register({ id, kind: 'integration_setup', scope: { sessionId: 'session-9' }, blocking: true, payload: { provider } })
    await ask('tool-linear', 'linear')
    await ask('tool-github', 'github')

    await answerSetupRequests({ id: 'integration-9', agentSlug: 'agent-one', provider: 'linear' } as AgentIntegrationRecord)

    expect(fetch).toHaveBeenCalledOnce()
    const [path, init] = fetch.mock.calls[0]
    expect(path).toBe('/inputs/tool-linear/resolve')
    expect(JSON.parse(String(init?.body)).value).toContain('integration ID: integration-9')
    expect(await inputs.get('tool-linear')).toBeNull()
    expect(await inputs.get('tool-github')).not.toBeNull()
    await inputs.resolve('tool-github', 'cancelled')
  })

  it('lists integrations with only active chat sessions', async () => {
    const res = await app.request('http://localhost/api/x-agent/chat/list', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      integrations: [{
        id: 'integration-1',
        provider: 'slack',
        name: 'Team Slack',
        status: 'connected',
        capabilities: [],
        chats: [{ chatId: 'chat-1', displayName: 'General' }],
      }],
    })
    expect(mockListChatIntegrations).toHaveBeenCalledWith('agent-one')
    // Archived rows are left out by the query, not by the route.
    expect(mockListActiveAgentIntegrationSessions).toHaveBeenCalledWith('integration-1')
  })

  it('labels chats and advertises capabilities from the connector class statics', async () => {
    mockGetConnectorClass.mockResolvedValue({
      capabilities: ['list_users', 'list_channels', 'dm_by_user_id'],
    })
    mockListActiveAgentIntegrationSessions.mockReturnValue([
      { externalChatId: 'D0AAA111', displayName: 'Iddo Gino', archivedAt: null, updatedAt: FIXED_TIME, createdAt: FIXED_TIME },
      { externalChatId: 'C0BBB222|123.456', displayName: '#office — Nov 2, 3:04 PM', archivedAt: null, updatedAt: FIXED_TIME, createdAt: FIXED_TIME },
      { externalChatId: 'C0BBB222|123.789', displayName: '#office — Nov 2, 3:09 PM', archivedAt: null, updatedAt: FIXED_TIME, createdAt: FIXED_TIME },
    ])

    const res = await app.request('http://localhost/api/x-agent/chat/list', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token' },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.integrations[0].capabilities).toEqual(['list_users', 'list_channels', 'dm_by_user_id'])
    expect(body.integrations[0].chats).toEqual([
      { chatId: 'D0AAA111', displayName: 'Iddo Gino', type: 'dm' },
      { chatId: 'C0BBB222', displayName: '#office', type: 'channel', threads: [
        { chatId: 'C0BBB222|123.456', displayName: '#office — Nov 2, 3:04 PM', type: 'thread' },
        { chatId: 'C0BBB222|123.789', displayName: '#office — Nov 2, 3:09 PM', type: 'thread' },
      ] },
    ])
  })

  it('sends without a chat_id to the one channel whose threads are the only active chats', async () => {
    mockListActiveAgentIntegrationSessions.mockReturnValue([
      { externalChatId: 'C0DEALS|1000.001', displayName: '#deals — Nov 2, 3:04 PM', archivedAt: null, updatedAt: FIXED_TIME, createdAt: FIXED_TIME },
      { externalChatId: 'C0DEALS|1000.002', displayName: '#deals — Nov 2, 3:09 PM', archivedAt: null, updatedAt: FIXED_TIME, createdAt: FIXED_TIME },
    ])

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ integration_id: 'integration-1', message: 'Weekly digest' }),
    })

    expect(res.status).toBe(200)
    expect(connector.sendMessage).toHaveBeenCalledWith('C0DEALS', { text: 'Weekly digest' })
    // The channel has no session of its own, so none is opened just to hold the note.
    expect(mockEnsureSession).not.toHaveBeenCalled()
  })

  it('does not send through integrations owned by another agent', async () => {
    mockGetChatIntegration.mockReturnValue(createIntegration({ agentSlug: 'agent-two' }))

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integration_id: 'integration-1',
        message: 'Ship the update',
        chat_id: 'chat-1',
      }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Chat integration does not belong to this agent' })
    expect(connector.sendMessage).not.toHaveBeenCalled()
  })

  it('reconnects a missing connector, sends the message, and notifies the agent session', async () => {
    immediateTimeout()
    mockGetConnector.mockReturnValueOnce(undefined).mockReturnValue(connector)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integration_id: 'integration-1',
        message: 'Ship the update',
        context: 'Asked from a scheduled task',
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ chatId: 'chat-1', provider: 'slack' })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('getConnector returned undefined'))
    expect(mockAddIntegration).toHaveBeenCalledWith('integration-1')
    expect(connector.startWorking).toHaveBeenCalledWith('chat-1', 'working')
    expect(connector.sendMessage).toHaveBeenCalledWith('chat-1', { text: 'Ship the update' })
    expect(mockEnsureSession).toHaveBeenCalledWith('integration-1', 'chat-1')
    expect(mockEnsureRunning).toHaveBeenCalledWith('agent-one')
    expect(containerSendMessage).toHaveBeenCalledWith(
      'session-1',
      '[SYSTEM] A message was sent to the user on your behalf via chat integration:\n[Internal context: Asked from a scheduled task]\n\nShip the update',
      undefined,
      { shouldQuery: false, preserveRuntime: true, messageContext: { sender: { type: 'agent', id: expect.any(String) }, session_trigger: expect.any(String) } },
    )
  })

  it('reports why a send failed without the message, and tells the agent why and what was not sent', async () => {
    const notInChannel = new Error('An API error occurred: not_in_channel')
    connector.sendMessage.mockRejectedValue(notInChannel)

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ integration_id: 'integration-1', message: 'Ship the update' }),
    })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Not sent (An API error occurred: not_in_channel): Ship the update' })
    expect(mockCaptureException).toHaveBeenCalledWith(notInChannel, expect.anything())
  })

  it('answers the agent when the send runs out of time while a post is still in flight', async () => {
    immediateTimeout()
    connector.sendMessage.mockReturnValue(new Promise(() => {}))

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ integration_id: 'integration-1', message: 'Ship the update' }),
    })

    expect(res.status).toBe(200)
    expect(connector.sendMessage).toHaveBeenCalledWith('chat-1', { text: 'Ship the update' })
  })

  it('falls back to appending JSONL when the live container cannot be notified', async () => {
    immediateTimeout()
    mockEnsureRunning.mockRejectedValue(new Error('container down'))

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integration_id: 'integration-1',
        message: 'Daily summary is ready',
        chat_id: 'chat-1',
      }),
    })

    expect(res.status).toBe(200)
    expect(mockAppendFile).toHaveBeenCalledWith(
      '/tmp/superagent/agent-one/.claude/projects/-workspace/session-1.jsonl',
      expect.any(Buffer),
    )

    const entry = JSON.parse((mockAppendFile.mock.calls[0][1] as Buffer).toString('utf-8').trim())
    expect(entry.type).toBe('assistant')
    expect(entry.sessionId).toBe('session-1')
    expect(entry.parentUuid).toBeNull()
    expect(entry.message.content).toEqual([{
      type: 'text',
      text: '[SYSTEM] A message was sent to the user on your behalf via chat integration:\nDaily summary is ready',
    }])
  })

  it('returns 403 when the chat is not approved for the integration', async () => {
    immediateTimeout()
    // Reconfigure 'integration-1' in the DB to telegram+require_approval=1.
    // 'chat-blocked' has no access row, so isChatAllowed returns false via real SQL.
    testSqlite
      .prepare(`UPDATE chat_integrations SET provider = 'telegram', require_approval = 1 WHERE id = 'integration-1'`)
      .run()

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integration_id: 'integration-1',
        message: 'Hello',
        chat_id: 'chat-blocked',
      }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'This conversation is not approved for this integration.' })
    expect(connector.sendMessage).not.toHaveBeenCalled()
  })

  // Own-chat guard: a chat-conversation session's replies already stream back
  // to its chat, so sends into that same chat are rejected as double-posts.

  it('rejects a send from a chat session that omits chat_id (own chat implied)', async () => {
    mockGetAgentIntegrationSessionBySessionId.mockReturnValue({
      integrationId: 'integration-1', externalChatId: 'chat-1', displayName: 'General', archivedAt: null,
    })

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integration_id: 'integration-1',
        message: 'Thanks for the feedback!',
        session_id: 'caller-session',
      }),
    })

    expect(res.status).toBe(400)
    const { error } = await res.json() as { error: string }
    expect(error).toContain('chat chat-1 (General)')
    expect(error).toContain('delivered to that chat automatically')
    expect(mockGetAgentIntegrationSessionBySessionId).toHaveBeenCalledWith('agent-one', 'caller-session')
    expect(connector.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects a send from a chat session that explicitly targets its own chat', async () => {
    mockGetAgentIntegrationSessionBySessionId.mockReturnValue({
      integrationId: 'integration-1', externalChatId: 'chat-1', displayName: null, archivedAt: null,
    })

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integration_id: 'integration-1',
        message: 'Thanks for the feedback!',
        chat_id: 'chat-1',
        session_id: 'caller-session',
      }),
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('post it twice')
    expect(connector.sendMessage).not.toHaveBeenCalled()
  })

  it('lets a thread session also send a takeaway to its own thread or another thread', async () => {
    immediateTimeout()
    mockGetConnectorClass.mockResolvedValue(chatDefinitions.slack)
    mockGetAgentIntegrationSessionBySessionId.mockReturnValue({
      integrationId: 'integration-1', externalChatId: 'C1|100.1', displayName: null, archivedAt: null,
    })

    for (const chat_id of [undefined, 'C1|100.1', 'C1|200.2']) {
      const res = await sendRequest({ message: 'Decision: we pass on Acme.', chat_id, also_send_to_channel: true, session_id: 'caller-session' })
      expect(res.status).toBe(200)
    }

    expect(connector.sendMessage.mock.calls).toEqual([
      ['C1|100.1', { text: 'Decision: we pass on Acme.', alsoSendToChannel: true }],
      ['C1|100.1', { text: 'Decision: we pass on Acme.', alsoSendToChannel: true }],
      ['C1|200.2', { text: 'Decision: we pass on Acme.', alsoSendToChannel: true }],
    ])
    expect(mockEnsureSession.mock.calls.map(([, chatId]) => chatId)).toEqual(['C1|200.2'])
  })

  it('refuses also_send_to_channel outside a thread', async () => {
    mockGetConnectorClass.mockResolvedValue({ capabilities: ['thread_broadcast'] })
    mockGetAgentIntegrationSessionBySessionId.mockReturnValue({
      integrationId: 'integration-1', externalChatId: 'D1', displayName: null, archivedAt: null,
    })

    for (const target of [{}, { chat_id: 'C1' }, { chat_id: 'C1|' }, { user_id: 'U1' }]) {
      const res = await sendRequest({ ...target, also_send_to_channel: true, session_id: 'caller-session' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('only for a thread in a channel')
    }
    expect(connector.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses also_send_to_channel on providers without thread_broadcast, without touching the connector', async () => {
    mockGetConnector.mockReturnValue(undefined)

    const res = await sendRequest({ chat_id: 'C1|100.1', also_send_to_channel: true })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('does not support also_send_to_channel')
    expect(mockAddIntegration).not.toHaveBeenCalled()
    expect(connector.sendMessage).not.toHaveBeenCalled()
  })

  it('allows a chat session to message a different chat on the same integration', async () => {
    immediateTimeout()
    mockGetAgentIntegrationSessionBySessionId.mockReturnValue({
      integrationId: 'integration-1', externalChatId: 'chat-1', displayName: 'General', archivedAt: null,
    })

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integration_id: 'integration-1',
        message: 'Heads up — your order arrived.',
        chat_id: 'dm-other-user',
        session_id: 'caller-session',
      }),
    })

    expect(res.status).toBe(200)
    expect(connector.sendMessage).toHaveBeenCalledWith('dm-other-user', { text: 'Heads up — your order arrived.' })
  })

  it('does not guard sends from an archived chat session (streaming is torn down)', async () => {
    immediateTimeout()
    mockGetAgentIntegrationSessionBySessionId.mockReturnValue({
      integrationId: 'integration-1', externalChatId: 'chat-1', displayName: 'General', archivedAt: new Date(),
    })

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integration_id: 'integration-1',
        message: 'Follow-up after rotation',
        chat_id: 'chat-1',
        session_id: 'caller-session',
      }),
    })

    expect(res.status).toBe(200)
    expect(connector.sendMessage).toHaveBeenCalledWith('chat-1', { text: 'Follow-up after rotation' })
  })

  it('does not guard sends whose calling session serves a different integration', async () => {
    immediateTimeout()
    mockGetAgentIntegrationSessionBySessionId.mockReturnValue({
      integrationId: 'integration-2', externalChatId: 'chat-1', displayName: null, archivedAt: null,
    })

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integration_id: 'integration-1',
        message: 'Cross-integration notify',
        chat_id: 'chat-1',
        session_id: 'caller-session',
      }),
    })

    expect(res.status).toBe(200)
    expect(connector.sendMessage).toHaveBeenCalledWith('chat-1', { text: 'Cross-integration notify' })
  })

  it('sends message when the integration has no access restriction (real DB allows it)', async () => {
    immediateTimeout()
    // 'integration-1' is seeded as slack (require_approval=0) in beforeEach,
    // so isChatAllowed returns true via real SQL without needing an access row.

    const res = await app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integration_id: 'integration-1',
        message: 'Hello',
        chat_id: 'chat-1',
      }),
    })

    expect(res.status).toBe(200)
    expect(connector.sendMessage).toHaveBeenCalledWith('chat-1', { text: 'Hello' })
  })

  // ── Discovery: send by user_id ─────────────────────────────────────

  function sendRequest(body: Record<string, unknown>) {
    return app.request('http://localhost/api/x-agent/chat/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ integration_id: 'integration-1', message: 'DM for Mike', ...body }),
    })
  }

  it('resolves a user_id to a direct chat and sends there', async () => {
    immediateTimeout()
    mockGetConnectorClass.mockResolvedValue({ capabilities: ['dm_by_user_id'] })
    const resolveDirectChat = vi.fn().mockResolvedValue('D0NEWCHAT')
    mockGetConnector.mockReturnValue({ ...connector, resolveDirectChat })

    const res = await sendRequest({ user_id: 'U0MIKE' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ chatId: 'D0NEWCHAT', provider: 'slack' })
    expect(resolveDirectChat).toHaveBeenCalledWith('U0MIKE')
    expect(connector.sendMessage).toHaveBeenCalledWith('D0NEWCHAT', { text: 'DM for Mike' })
  })

  it('rejects passing both chat_id and user_id', async () => {
    const res = await sendRequest({ chat_id: 'chat-1', user_id: 'U0MIKE' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('either chat_id or user_id')
    expect(connector.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects user_id sends on providers without dm_by_user_id support, without touching the connector', async () => {
    // Default mockGetConnectorClass resolves undefined — no capabilities. The
    // connector must never be resolved: a reconnect attempt could resurrect an
    // integration just to tell the caller the provider can't do this anyway.
    mockGetConnector.mockReturnValue(undefined)

    const res = await sendRequest({ user_id: 'U0MIKE' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('does not support messaging by user_id')
    expect(mockAddIntegration).not.toHaveBeenCalled()
    expect(connector.sendMessage).not.toHaveBeenCalled()
  })

  it('surfaces DM-resolution failures as a clear error', async () => {
    mockGetConnectorClass.mockResolvedValue({ capabilities: ['dm_by_user_id'] })
    const resolveDirectChat = vi.fn().mockRejectedValue(new Error('user_not_found'))
    mockGetConnector.mockReturnValue({ ...connector, resolveDirectChat })

    const res = await sendRequest({ user_id: 'U0GONE' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Could not open a direct chat with user U0GONE')
    expect(connector.sendMessage).not.toHaveBeenCalled()
  })

  it('applies the own-chat guard to the chat a user_id resolves to', async () => {
    // The caller session IS the DM conversation with this user: resolving the
    // user id lands on the caller's own chat, which must still be rejected.
    mockGetConnectorClass.mockResolvedValue({ capabilities: ['dm_by_user_id'] })
    const resolveDirectChat = vi.fn().mockResolvedValue('D0AAA111')
    mockGetConnector.mockReturnValue({ ...connector, resolveDirectChat })
    mockGetAgentIntegrationSessionBySessionId.mockReturnValue({
      integrationId: 'integration-1', externalChatId: 'D0AAA111', displayName: 'Iddo Gino', archivedAt: null,
    })

    const res = await sendRequest({ user_id: 'U0IDDO', session_id: 'caller-session' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('post it twice')
    expect(connector.sendMessage).not.toHaveBeenCalled()
  })

  // ── Discovery: directory endpoints ─────────────────────────────────

  function directoryRequest(op: 'users' | 'channels', body: Record<string, unknown> = { integration_id: 'integration-1' }) {
    return app.request(`http://localhost/api/x-agent/chat/${op}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('lists directory users through the connector', async () => {
    mockGetConnectorClass.mockResolvedValue({ capabilities: ['list_users', 'list_channels'] })
    const listChatUsers = vi.fn().mockResolvedValue({
      items: [{ id: 'U0MIKE', name: 'Mike Reid', title: 'Office Manager' }],
      truncated: false,
    })
    mockGetConnector.mockReturnValue({ ...connector, listChatUsers })

    const res = await directoryRequest('users')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      provider: 'slack',
      users: [{ id: 'U0MIKE', name: 'Mike Reid', title: 'Office Manager' }],
      truncated: false,
    })
  })

  it('lists directory channels and passes the truncation flag through', async () => {
    mockGetConnectorClass.mockResolvedValue({ capabilities: ['list_users', 'list_channels'] })
    const listChatChannels = vi.fn().mockResolvedValue({
      items: [{ id: 'C0OFFICE', name: '#office', isPrivate: false, isMember: true }],
      truncated: true,
    })
    mockGetConnector.mockReturnValue({ ...connector, listChatChannels })

    const res = await directoryRequest('channels')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      provider: 'slack',
      channels: [{ id: 'C0OFFICE', name: '#office', isPrivate: false, isMember: true }],
      truncated: true,
    })
  })

  it('returns a graceful 400 when the provider has no directory support, without touching the connector', async () => {
    // Default mockGetConnectorClass resolves undefined — no capabilities. Even
    // with no live connector, an unsupported provider must get the capability
    // answer, not a reconnect attempt followed by a connection error.
    mockGetConnector.mockReturnValue(undefined)

    const usersRes = await directoryRequest('users')
    expect(usersRes.status).toBe(400)
    expect((await usersRes.json()).error).toBe('The slack provider does not support listing users.')

    const channelsRes = await directoryRequest('channels')
    expect(channelsRes.status).toBe(400)
    expect((await channelsRes.json()).error).toBe('The slack provider does not support listing channels.')
    expect(mockAddIntegration).not.toHaveBeenCalled()
  })

  it('does not reconnect a paused integration for directory listings', async () => {
    mockGetConnectorClass.mockResolvedValue({ capabilities: ['list_users', 'list_channels'] })
    mockGetChatIntegration.mockReturnValue(createIntegration({ status: 'paused' }))
    mockGetConnector.mockReturnValue(undefined)

    const res = await directoryRequest('users')

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('paused')
    expect(mockAddIntegration).not.toHaveBeenCalled()
  })

  it('rejects directory listings for integrations owned by another agent', async () => {
    mockGetChatIntegration.mockReturnValue(createIntegration({ agentSlug: 'agent-two' }))
    const listChatUsers = vi.fn()
    mockGetConnector.mockReturnValue({ ...connector, listChatUsers })

    const res = await directoryRequest('users')

    expect(res.status).toBe(403)
    expect(listChatUsers).not.toHaveBeenCalled()
  })

  it('requires integration_id on directory listings', async () => {
    const res = await directoryRequest('users', {})
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('integration_id')
  })
})

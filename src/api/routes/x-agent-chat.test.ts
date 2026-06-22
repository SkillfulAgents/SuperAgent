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
  get sqlite() { return testSqlite },
}))

const mockEnsureRunning = vi.fn()

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    ensureRunning: (...args: unknown[]) => mockEnsureRunning(...args),
  },
}))

const mockValidateProxyToken = vi.fn()

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...args: unknown[]) => mockValidateProxyToken(...args),
}))

const mockGetChatIntegration = vi.fn()
const mockCreateChatIntegration = vi.fn()
const mockListChatIntegrations = vi.fn()
const mockUpdateChatIntegrationStatus = vi.fn()

const MockDuplicateBotTokenError = vi.hoisted(() => class DuplicateBotTokenError extends Error {})

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: (...args: unknown[]) => mockGetChatIntegration(...args),
  createChatIntegration: (...args: unknown[]) => mockCreateChatIntegration(...args),
  listChatIntegrations: (...args: unknown[]) => mockListChatIntegrations(...args),
  updateChatIntegrationStatus: (...args: unknown[]) => mockUpdateChatIntegrationStatus(...args),
  DuplicateBotTokenError: MockDuplicateBotTokenError,
}))

const mockListChatIntegrationSessions = vi.fn()

vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  listChatIntegrationSessions: (...args: unknown[]) => mockListChatIntegrationSessions(...args),
}))

const mockAddIntegration = vi.fn()
const mockGetConnector = vi.fn()
const mockGetActiveIntegrationIds = vi.fn()
const mockEnsureSession = vi.fn()
const mockShareDashboard = vi.fn()

vi.mock('@shared/lib/chat-integrations/chat-integration-manager', () => ({
  chatIntegrationManager: {
    addIntegration: (...args: unknown[]) => mockAddIntegration(...args),
    getConnector: (...args: unknown[]) => mockGetConnector(...args),
    getActiveIntegrationIds: (...args: unknown[]) => mockGetActiveIntegrationIds(...args),
    ensureSession: (...args: unknown[]) => mockEnsureSession(...args),
    shareDashboard: (...args: unknown[]) => mockShareDashboard(...args),
  },
}))

const mockValidateChatIntegrationConfig = vi.fn()

vi.mock('@shared/lib/chat-integrations/config-schema', () => ({
  validateChatIntegrationConfig: (...args: unknown[]) => mockValidateChatIntegrationConfig(...args),
  CHAT_PROVIDERS: ['slack', 'telegram', 'imessage'],
  IMESSAGE_GATEWAY_URL: 'https://imessage-gateway.example.com',
  imessageSetupSchema: {
    safeParse: () => ({ success: true, data: { phoneNumber: '+15555550100', code: '123456' } }),
  },
}))

const mockGetSessionJsonlPath = vi.fn()

vi.mock('@shared/lib/utils/file-storage', () => ({
  getSessionJsonlPath: (...args: unknown[]) => mockGetSessionJsonlPath(...args),
}))

const mockCaptureException = vi.fn()

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

const mockListArtifactsFromFilesystem = vi.fn()

vi.mock('@shared/lib/services/artifact-service', () => ({
  listArtifactsFromFilesystem: (...args: unknown[]) => mockListArtifactsFromFilesystem(...args),
}))

const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockAppendFileSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  appendFileSync: (...args: unknown[]) => mockAppendFileSync(...args),
}))

import xAgentChat from './x-agent-chat'

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
    mockListChatIntegrationSessions.mockReturnValue([
      { externalChatId: 'chat-1', displayName: 'General', archivedAt: null },
    ])
    mockGetConnector.mockReturnValue(connector)
    mockGetActiveIntegrationIds.mockReturnValue(['integration-1'])
    mockEnsureSession.mockResolvedValue('session-1')
    mockEnsureRunning.mockResolvedValue({ sendMessage: containerSendMessage })
    mockGetSessionJsonlPath.mockReturnValue('/tmp/superagent/agent-one/session-1.jsonl')
    mockExistsSync.mockReturnValue(false)
    mockListArtifactsFromFilesystem.mockResolvedValue([
      { slug: 'weekly-report', name: 'Weekly', description: '', status: 'stopped', port: 0 },
    ])
    mockShareDashboard.mockResolvedValue('button')
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    testSqlite?.close()
    vi.restoreAllMocks()
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

  it('lists integrations with only active chat sessions', async () => {
    mockListChatIntegrationSessions.mockReturnValue([
      { externalChatId: 'chat-1', displayName: 'General', archivedAt: null },
      { externalChatId: 'chat-archived', displayName: 'Old thread', archivedAt: '2026-01-01T00:00:00.000Z' },
    ])

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
        chats: [{ chatId: 'chat-1', displayName: 'General' }],
      }],
    })
    expect(mockListChatIntegrations).toHaveBeenCalledWith('agent-one')
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
    expect(connector.startWorking).toHaveBeenCalledWith('chat-1')
    expect(connector.sendMessage).toHaveBeenCalledWith('chat-1', { text: 'Ship the update' })
    expect(mockEnsureSession).toHaveBeenCalledWith('integration-1', 'chat-1')
    expect(mockEnsureRunning).toHaveBeenCalledWith('agent-one')
    expect(containerSendMessage).toHaveBeenCalledWith(
      'session-1',
      '[SYSTEM] A message was sent to the user on your behalf via chat integration:\n[Internal context: Asked from a scheduled task]\n\nShip the update',
      undefined,
      { shouldQuery: false },
    )
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
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/superagent/agent-one', { recursive: true })
    expect(mockAppendFileSync).toHaveBeenCalledWith(
      '/tmp/superagent/agent-one/session-1.jsonl',
      expect.stringContaining('"type":"assistant"'),
    )

    const entry = JSON.parse((mockAppendFileSync.mock.calls[0][1] as string).trim())
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

  describe('POST /share-dashboard', () => {
    function createTelegramIntegration(overrides: Record<string, unknown> = {}) {
      return createIntegration({ provider: 'telegram', status: 'active', createdByUserId: 'owner-1', ...overrides })
    }

    beforeEach(() => {
      mockGetChatIntegration.mockReturnValue(createTelegramIntegration())
      mockListChatIntegrations.mockReturnValue([createTelegramIntegration()])
    })

    it('shares a dashboard and returns 200 with chatId when auto-resolved', async () => {
      const res = await app.request('http://localhost/api/x-agent/chat/share-dashboard', {
        method: 'POST',
        headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'weekly-report' }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ chatId: 'chat-1', delivery: 'button' })
      expect(mockShareDashboard).toHaveBeenCalledOnce()
      expect(mockShareDashboard).toHaveBeenCalledWith(
        'integration-1',
        'chat-1',
        { agentSlug: 'agent-one', dashboardSlug: 'weekly-report', name: 'Weekly', allowButton: true },
      )
    })

    it('passes through delivery=text when the connector falls back to plain text', async () => {
      mockShareDashboard.mockResolvedValue('text')

      const res = await app.request('http://localhost/api/x-agent/chat/share-dashboard', {
        method: 'POST',
        headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'weekly-report' }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ chatId: 'chat-1', delivery: 'text' })
    })

    it('passes allowButton=false when the integration has no owner (createdByUserId null)', async () => {
      // Integrations created before createdByUserId was captured would otherwise
      // send a button that 401s on tap; the route must signal text-only delivery.
      mockGetChatIntegration.mockReturnValue(createTelegramIntegration({ createdByUserId: null }))
      mockListChatIntegrations.mockReturnValue([createTelegramIntegration({ createdByUserId: null })])
      mockShareDashboard.mockResolvedValue('text')

      const res = await app.request('http://localhost/api/x-agent/chat/share-dashboard', {
        method: 'POST',
        headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'weekly-report' }),
      })

      expect(res.status).toBe(200)
      expect(mockShareDashboard).toHaveBeenCalledWith(
        'integration-1',
        'chat-1',
        { agentSlug: 'agent-one', dashboardSlug: 'weekly-report', name: 'Weekly', allowButton: false },
      )
    })

    it('returns 403 when the chat is not approved for the integration', async () => {
      // Flip integration-1 to telegram + require_approval so isChatAllowed gates via real SQL.
      // 'chat-blocked' has no access row, so isChatAllowed returns false.
      testSqlite
        .prepare(`UPDATE chat_integrations SET provider = 'telegram', require_approval = 1 WHERE id = 'integration-1'`)
        .run()

      const res = await app.request('http://localhost/api/x-agent/chat/share-dashboard', {
        method: 'POST',
        headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'weekly-report', integration_id: 'integration-1', chat_id: 'chat-blocked' }),
      })

      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'This conversation is not approved for this integration.' })
      expect(mockShareDashboard).not.toHaveBeenCalled()
    })

    it('rejects requests without a valid proxy token', async () => {
      mockValidateProxyToken.mockResolvedValue(null)

      const res = await app.request('http://localhost/api/x-agent/chat/share-dashboard', {
        method: 'POST',
        headers: { Authorization: 'Bearer bad-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'weekly-report' }),
      })

      expect(res.status).toBe(401)
      expect(mockShareDashboard).not.toHaveBeenCalled()
    })

    it('returns 403 when integration belongs to another agent', async () => {
      mockGetChatIntegration.mockReturnValue(createTelegramIntegration({ agentSlug: 'other' }))

      const res = await app.request('http://localhost/api/x-agent/chat/share-dashboard', {
        method: 'POST',
        headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'weekly-report', integration_id: 'integration-1' }),
      })

      expect(res.status).toBe(403)
      expect(mockShareDashboard).not.toHaveBeenCalled()
    })

    it('returns 404 when dashboard slug does not exist', async () => {
      mockListArtifactsFromFilesystem.mockResolvedValue([])

      const res = await app.request('http://localhost/api/x-agent/chat/share-dashboard', {
        method: 'POST',
        headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'weekly-report' }),
      })

      expect(res.status).toBe(404)
      expect(mockShareDashboard).not.toHaveBeenCalled()
    })
  })
})

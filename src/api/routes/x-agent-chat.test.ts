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
const mockGetChatIntegrationSessionBySessionId = vi.fn()

vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  listChatIntegrationSessions: (...args: unknown[]) => mockListChatIntegrationSessions(...args),
  getChatIntegrationSessionBySessionId: (...args: unknown[]) => mockGetChatIntegrationSessionBySessionId(...args),
}))

const mockAddIntegration = vi.fn()
const mockGetConnector = vi.fn()
const mockGetActiveIntegrationIds = vi.fn()
const mockEnsureSession = vi.fn()
const mockGetConnectorClass = vi.fn()

vi.mock('@shared/lib/chat-integrations/chat-integration-manager', () => ({
  chatIntegrationManager: {
    addIntegration: (...args: unknown[]) => mockAddIntegration(...args),
    getConnector: (...args: unknown[]) => mockGetConnector(...args),
    getActiveIntegrationIds: (...args: unknown[]) => mockGetActiveIntegrationIds(...args),
    ensureSession: (...args: unknown[]) => mockEnsureSession(...args),
    getConnectorClass: (...args: unknown[]) => mockGetConnectorClass(...args),
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
    mockGetChatIntegrationSessionBySessionId.mockReturnValue(null)
    mockGetConnector.mockReturnValue(connector)
    mockGetConnectorClass.mockResolvedValue(undefined)
    mockGetActiveIntegrationIds.mockReturnValue(['integration-1'])
    mockEnsureSession.mockResolvedValue('session-1')
    mockEnsureRunning.mockResolvedValue({ sendMessage: containerSendMessage })
    mockGetSessionJsonlPath.mockReturnValue('/tmp/superagent/agent-one/session-1.jsonl')
    mockExistsSync.mockReturnValue(false)
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
        capabilities: [],
        chats: [{ chatId: 'chat-1', displayName: 'General' }],
      }],
    })
    expect(mockListChatIntegrations).toHaveBeenCalledWith('agent-one')
  })

  it('labels chats and advertises capabilities from the connector class statics', async () => {
    mockGetConnectorClass.mockResolvedValue({
      discoveryCapabilities: ['list_users', 'list_channels', 'dm_by_user_id'],
      classifyChatId: (chatId: string) => (chatId.startsWith('D') ? 'dm' : chatId.includes('|') ? 'thread' : 'channel'),
    })
    mockListChatIntegrationSessions.mockReturnValue([
      { externalChatId: 'D0AAA111', displayName: 'Iddo Gino', archivedAt: null },
      { externalChatId: 'C0BBB222|123.456', displayName: '#office', archivedAt: null },
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
      { chatId: 'C0BBB222|123.456', displayName: '#office', type: 'thread' },
    ])
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

  // Own-chat guard: a chat-conversation session's replies already stream back
  // to its chat, so sends into that same chat are rejected as double-posts.

  it('rejects a send from a chat session that omits chat_id (own chat implied)', async () => {
    mockGetChatIntegrationSessionBySessionId.mockReturnValue({
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
    expect(mockGetChatIntegrationSessionBySessionId).toHaveBeenCalledWith('caller-session')
    expect(connector.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects a send from a chat session that explicitly targets its own chat', async () => {
    mockGetChatIntegrationSessionBySessionId.mockReturnValue({
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

  it('allows a chat session to message a different chat on the same integration', async () => {
    immediateTimeout()
    mockGetChatIntegrationSessionBySessionId.mockReturnValue({
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
    mockGetChatIntegrationSessionBySessionId.mockReturnValue({
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
    mockGetChatIntegrationSessionBySessionId.mockReturnValue({
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
    mockGetConnectorClass.mockResolvedValue({ discoveryCapabilities: ['dm_by_user_id'] })
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
    mockGetConnectorClass.mockResolvedValue({ discoveryCapabilities: ['dm_by_user_id'] })
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
    mockGetConnectorClass.mockResolvedValue({ discoveryCapabilities: ['dm_by_user_id'] })
    const resolveDirectChat = vi.fn().mockResolvedValue('D0AAA111')
    mockGetConnector.mockReturnValue({ ...connector, resolveDirectChat })
    mockGetChatIntegrationSessionBySessionId.mockReturnValue({
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
    mockGetConnectorClass.mockResolvedValue({ discoveryCapabilities: ['list_users', 'list_channels'] })
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
    mockGetConnectorClass.mockResolvedValue({ discoveryCapabilities: ['list_users', 'list_channels'] })
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
    mockGetConnectorClass.mockResolvedValue({ discoveryCapabilities: ['list_users', 'list_channels'] })
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

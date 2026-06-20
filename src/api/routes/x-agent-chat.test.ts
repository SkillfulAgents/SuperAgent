import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

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

vi.mock('@shared/lib/chat-integrations/chat-integration-manager', () => ({
  chatIntegrationManager: {
    addIntegration: (...args: unknown[]) => mockAddIntegration(...args),
    getConnector: (...args: unknown[]) => mockGetConnector(...args),
    getActiveIntegrationIds: (...args: unknown[]) => mockGetActiveIntegrationIds(...args),
    ensureSession: (...args: unknown[]) => mockEnsureSession(...args),
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
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
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
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as path from 'path'
import * as schema from '../db/schema'
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Gate outbound ensureSession for non-allowed chats.
//
// ensureSession is called by the /send route before logging the outbound
// message into the session JSONL. If the chat is not approved for the
// integration, it must throw before any session work happens.
//
// isChatAllowed is exercised through the REAL access service reading REAL
// in-memory DB rows — the same pattern used by chat-integration-access-gate
// and chat-integration-access-service tests. The service layer (getChatIntegration,
// resolveActiveSession) is still mocked since it is not under test here.
// ---------------------------------------------------------------------------

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() { return testDb },
  get sqlite() { return testSqlite },
}))

const mockGetChatIntegration = vi.fn()

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: (...args: unknown[]) => mockGetChatIntegration(...args),
  listStartupChatIntegrations: vi.fn().mockReturnValue([]),
  updateChatIntegrationStatus: vi.fn(),
}))

const mockResolveActiveSession = vi.fn()

vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  getChatIntegrationSession: vi.fn(),
  getChatIntegrationSessionBySessionId: vi.fn(),
  createChatIntegrationSession: vi.fn(),
  updateChatIntegrationSessionName: vi.fn(),
  archiveChatIntegrationSession: vi.fn(),
  touchChatIntegrationSession: vi.fn(),
  listChatIntegrationSessions: vi.fn(),
  resolveActiveSession: (...args: unknown[]) => mockResolveActiveSession(...args),
  getLastDisplayName: vi.fn().mockReturnValue(null),
}))

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: { ensureRunning: vi.fn() },
}))

vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: { submitDecision: vi.fn() },
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

import { chatIntegrationManager } from './chat-integration-manager'

const INT = 'int-tg'

function fakeIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: INT,
    agentSlug: 'test-agent',
    provider: 'telegram',
    name: 'Test Bot',
    status: 'active',
    requireApproval: true,
    sessionTimeout: null,
    createdByUserId: null,
    config: '{}',
    ...overrides,
  }
}

function seedAccess(chatId: string, status: 'pending' | 'allowed' | 'denied'): void {
  const id = crypto.randomUUID()
  const now = Date.now()
  testSqlite
    .prepare(
      `INSERT INTO chat_integration_access
         (id, integration_id, external_chat_id, chat_type, status, requested_at, created_at, updated_at)
       VALUES (?, ?, ?, 'private', ?, ?, ?, ?)`,
    )
    .run(id, INT, chatId, status, now, now, now)
}

describe('ChatIntegrationManager.ensureSession — outbound access gate', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })

    // Seed a telegram integration with require_approval=1 so isChatAllowed
    // will check the chat_integration_access table for each chatId.
    const now = Date.now()
    testSqlite
      .prepare(
        `INSERT INTO chat_integrations (id, agent_slug, provider, config, require_approval, created_at, updated_at)
         VALUES (?, 'test-agent', 'telegram', '{}', 1, ?, ?)`,
      )
      .run(INT, now, now)

    vi.clearAllMocks()
    mockGetChatIntegration.mockReturnValue(fakeIntegration())
  })

  afterEach(() => {
    testSqlite?.close()
  })

  it('throws when the chat has no allowed access row (denied by real DB)', async () => {
    // No access row seeded → isChatAllowed('int-tg', 'chat-blocked') returns false
    await expect(
      chatIntegrationManager.ensureSession(INT, 'chat-blocked'),
    ).rejects.toThrow('Chat chat-blocked is not allowed for integration int-tg')
  })

  it('returns the existing sessionId when the chat has an allowed access row', async () => {
    seedAccess('chat-allowed', 'allowed')
    mockResolveActiveSession.mockReturnValue({ sessionId: 'existing-session-id' })

    const result = await chatIntegrationManager.ensureSession(INT, 'chat-allowed')

    expect(result).toBe('existing-session-id')
    expect(mockResolveActiveSession).toHaveBeenCalledWith(
      INT,
      'chat-allowed',
      null,
      expect.any(Function),
    )
  })
})

describe('ChatIntegrationManager.handleSSEEvent — outbound access gate', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    const now = Date.now()
    testSqlite
      .prepare(
        `INSERT INTO chat_integrations (id, agent_slug, provider, config, require_approval, created_at, updated_at)
         VALUES (?, 'test-agent', 'telegram', '{}', 1, ?, ?)`,
      )
      .run(INT, now, now)
    vi.clearAllMocks()
    mockGetChatIntegration.mockReturnValue(fakeIntegration())
  })

  afterEach(() => {
    testSqlite?.close()
  })

  it('does not forward an in-flight SSE event to a chat that is no longer allowed', async () => {
    // Simulate the revoke race: the chat has been denied but a managed session
    // is still mapped (teardown has not yet removed it).
    seedAccess('chat-denied', 'denied')
    const mgr = chatIntegrationManager as unknown as {
      getChatSessionKey: (i: string, c: string) => string
      chatSessions: Map<string, unknown>
      handleSSEEvent: (i: string, c: string, e: unknown, sessionId: string) => Promise<void>
    }
    const key = mgr.getChatSessionKey(INT, 'chat-denied')
    mgr.chatSessions.set(key, { chatId: 'chat-denied', integrationId: INT })

    await mgr.handleSSEEvent(INT, 'chat-denied', { type: 'assistant' }, 'sess-test')

    // The fail-closed guard returns before reading integration config or forwarding.
    expect(mockGetChatIntegration).not.toHaveBeenCalled()
    mgr.chatSessions.delete(key)
  })
})

describe('ChatIntegrationManager.reconcileAccess — gate sessions after approval is enabled', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    const now = Date.now()
    testSqlite
      .prepare(
        `INSERT INTO chat_integrations (id, agent_slug, provider, config, require_approval, created_at, updated_at)
         VALUES (?, 'test-agent', 'telegram', '{}', 1, ?, ?)`,
      )
      .run(INT, now, now)
    vi.clearAllMocks()
    mockGetChatIntegration.mockReturnValue(fakeIntegration())
  })

  afterEach(() => {
    testSqlite?.close()
  })

  it('tears down active sessions whose chat is no longer allowed, keeps allowed ones', async () => {
    seedAccess('allowed-chat', 'allowed')
    const sessionSvc = await import('@shared/lib/services/chat-integration-session-service')
    vi.mocked(sessionSvc.listChatIntegrationSessions).mockReturnValue([
      { id: 'sess-allowed', integrationId: INT, externalChatId: 'allowed-chat', sessionId: 'a', archivedAt: null },
      { id: 'sess-blocked', integrationId: INT, externalChatId: 'blocked-chat', sessionId: 'b', archivedAt: null },
    ] as never)
    vi.mocked(sessionSvc.getChatIntegrationSession).mockImplementation(
      ((_i: string, chatId: string) =>
        chatId === 'blocked-chat' ? { id: 'sess-blocked' } : { id: 'sess-allowed' }) as never,
    )

    await chatIntegrationManager.reconcileAccess(INT)

    // 'blocked-chat' has no allowed row → torn down; 'allowed-chat' is kept.
    expect(sessionSvc.archiveChatIntegrationSession).toHaveBeenCalledWith('sess-blocked')
    expect(sessionSvc.archiveChatIntegrationSession).not.toHaveBeenCalledWith('sess-allowed')
  })
})

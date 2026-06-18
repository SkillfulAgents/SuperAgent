import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as path from 'path'
import * as schema from '../db/schema'
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Reconnect restoration filter (Task 8)
//
// When an integration reconnects, subscribeChatSession must be called ONLY for
// sessions that are both active (archivedAt IS NULL) AND allowed by the access
// service. Archived sessions and sessions with no allowed access row must be
// skipped.
//
// isChatAllowed and listChatIntegrationSessions run against a REAL in-memory
// DB so the filter is exercised via actual SQL, not mocked return values.
// The connector is stubbed so connector.connect() succeeds without network I/O.
// ---------------------------------------------------------------------------

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() { return testDb },
  get sqlite() { return testSqlite },
}))

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: vi.fn(),
  listStartupChatIntegrations: vi.fn().mockReturnValue([]),
  updateChatIntegrationStatus: vi.fn(),
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
import type { ChatClientConnector } from './base-connector'

const INT = 'int-restore-test'

interface ManagerTestSurface {
  connectIntegration(integration: unknown): Promise<void>
  subscribeChatSession(integrationId: string, chatId: string, sessionId: string): void
  createConnector(integration: unknown): Promise<ChatClientConnector>
  connections: Map<string, unknown>
}

const mgr = chatIntegrationManager as unknown as ManagerTestSurface

function fakeIntegration() {
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
  }
}

function fakeConnector(): ChatClientConnector {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
    onMessage: vi.fn().mockReturnValue(() => {}),
    onInteractiveResponse: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    onTypingHint: vi.fn().mockReturnValue(() => {}),
  } as unknown as ChatClientConnector
}

function seedIntegration(): void {
  const now = Date.now()
  testSqlite
    .prepare(
      `INSERT INTO chat_integrations (id, agent_slug, provider, config, require_approval, created_at, updated_at)
       VALUES (?, 'test-agent', 'telegram', '{}', 1, ?, ?)`,
    )
    .run(INT, now, now)
}

function seedSession(externalChatId: string, sessionId: string, archivedAt?: number): void {
  const id = crypto.randomUUID()
  const now = Date.now()
  testSqlite
    .prepare(
      `INSERT INTO chat_integration_sessions
         (id, integration_id, external_chat_id, session_id, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, INT, externalChatId, sessionId, archivedAt ?? null, now, now)
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

describe('ChatIntegrationManager — reconnect restoration filter', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    seedIntegration()
    vi.clearAllMocks()
  })

  afterEach(() => {
    mgr.connections.delete(INT)
    testSqlite?.close()
  })

  it('subscribes only the active+allowed session on reconnect; skips archived and denied', async () => {
    // active + allowed → must subscribe
    seedSession('chat-allowed', 'session-allowed')
    // active + no access row → isChatAllowed returns false → skip
    seedSession('chat-denied', 'session-denied')
    // archived + allowed access row → must skip because archivedAt is set
    seedSession('chat-archived', 'session-archived', Date.now())

    seedAccess('chat-allowed', 'allowed')
    // chat-denied: no access row (absent = not allowed)
    seedAccess('chat-archived', 'allowed')

    vi.spyOn(mgr, 'createConnector').mockResolvedValue(fakeConnector())
    const subscribeSpy = vi.spyOn(mgr, 'subscribeChatSession').mockImplementation(() => {})

    await mgr.connectIntegration(fakeIntegration())

    expect(subscribeSpy).toHaveBeenCalledTimes(1)
    expect(subscribeSpy).toHaveBeenCalledWith(INT, 'chat-allowed', 'session-allowed')
  })
})

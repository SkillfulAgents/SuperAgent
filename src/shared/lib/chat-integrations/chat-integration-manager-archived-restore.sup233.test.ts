/**
 * SUP-233 — Chat integration reconnect restores archived session SSE forwarding.
 *
 * On connect/reconnect the manager restored SSE subscriptions for EVERY session
 * row of an integration (`listChatIntegrationSessions`), with no `archivedAt`
 * filter. Archived/cleared/timed-out sessions got re-subscribed and could forward
 * stale agent output back to the external chat.
 *
 * This drives the real restore path (addIntegration -> connectIntegration ->
 * restore loop) against an in-memory DB seeded with one active and one archived
 * session, and asserts `messagePersister.addSSEClient` is wired only for the
 * active session. It also covers the new active-only listing helper directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

// ── Test state ─────────────────────────────────────────────────────────

let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

// ── Mocks (mirror chat-integration-e2e.test.ts preamble) ───────────────

vi.mock('../db', () => ({
  get db() { return testDb },
  get sqlite() { return testSqlite },
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: (_userId: string | undefined, fn: () => unknown) => fn(),
}))

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: { ensureRunning: vi.fn() },
}))

vi.mock('@shared/lib/services/session-service', () => ({
  registerSession: vi.fn(),
  updateSessionMetadata: vi.fn(),
  getSessionMetadata: vi.fn().mockResolvedValue(null),
}))

vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: { triggerChatIntegrationEvent: vi.fn().mockResolvedValue(undefined) },
}))

// Telegram connector → a real mock connector that connects without network.
vi.mock('./telegram-connector', async () => {
  const { MockChatClientConnector } = await import('./mock-connector')
  return {
    TelegramConnector: class {
      constructor() {
        return new MockChatClientConnector()
      }
    },
  }
})

// ── Imports (after mocks) ──────────────────────────────────────────────

import { chatIntegrationManager } from './chat-integration-manager'
import { createChatIntegration } from '@shared/lib/services/chat-integration-service'
import {
  createChatIntegrationSession,
  archiveChatIntegrationSession,
  listChatIntegrationSessions,
  listActiveChatIntegrationSessions,
} from '@shared/lib/services/chat-integration-session-service'
import { messagePersister } from '@shared/lib/container/message-persister'

describe('SUP-233 reconnect restore ignores archived sessions', () => {
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup233-'))
    process.env.SUPERAGENT_DATA_DIR = testDir
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  })

  afterEach(async () => {
    chatIntegrationManager.stop()
    await new Promise((r) => setTimeout(r, 20))
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {})
    vi.restoreAllMocks()
  })

  it('does not restore SSE forwarding for archived chat sessions on reconnect', async () => {
    // Public bot so the access gate is a no-op and this test isolates SUP-233's
    // concern (active sessions restore, archived don't). requireApproval is
    // owner-only post-create, so flip it directly on the row.
    const integrationId = createChatIntegration({
      agentSlug: 'test-agent',
      provider: 'telegram',
      config: { botToken: 'test-token-123' },
      name: 'Test Bot',
    })
    testSqlite.prepare('UPDATE chat_integrations SET require_approval = 0 WHERE id = ?').run(integrationId)

    // One active session, one archived session for the same integration.
    createChatIntegrationSession({
      integrationId,
      externalChatId: 'chat-active',
      sessionId: 'active-agent-session',
    })
    const archivedRowId = createChatIntegrationSession({
      integrationId,
      externalChatId: 'chat-archived',
      sessionId: 'archived-agent-session',
    })
    archiveChatIntegrationSession(archivedRowId)

    const addSSEClient = vi
      .spyOn(messagePersister, 'addSSEClient')
      .mockReturnValue(() => {})

    // Drives connectIntegration -> restore loop.
    await chatIntegrationManager.addIntegration(integrationId)

    const subscribedSessionIds = addSSEClient.mock.calls.map((c) => c[0])
    expect(subscribedSessionIds).toContain('active-agent-session')
    expect(subscribedSessionIds).not.toContain('archived-agent-session')
  })

  it('listActiveChatIntegrationSessions excludes archived rows; listChatIntegrationSessions keeps them', () => {
    const integrationId = createChatIntegration({
      agentSlug: 'test-agent-2',
      provider: 'telegram',
      config: { botToken: 'test-token-456' },
      name: 'Test Bot 2',
    })
    createChatIntegrationSession({ integrationId, externalChatId: 'c-a', sessionId: 's-active' })
    const archivedId = createChatIntegrationSession({ integrationId, externalChatId: 'c-b', sessionId: 's-archived' })
    archiveChatIntegrationSession(archivedId)

    const active = listActiveChatIntegrationSessions(integrationId).map((s) => s.sessionId)
    const all = listChatIntegrationSessions(integrationId).map((s) => s.sessionId)

    expect(active).toContain('s-active')
    expect(active).not.toContain('s-archived')
    expect(all).toEqual(expect.arrayContaining(['s-active', 's-archived']))
  })
})

/**
 * Chat integration E2E tests.
 *
 * Wires MockChatClientConnector → ChatIntegrationManager → MockContainerClient
 * to test the full message flow without real chat platforms or containers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'
import { MockChatClientConnector } from './mock-connector'

// ── Test state ─────────────────────────────────────────────────────────

let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>
let mockConnector: MockChatClientConnector
let mockContainerClient: any

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('../db', () => ({
  get db() { return testDb },
  get sqlite() { return testSqlite },
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: (_userId: string | undefined, fn: () => any) => fn(),
}))

// Mock the container manager — returns our mock client
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    ensureRunning: vi.fn(),
  },
}))

// Mock agent service
vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: vi.fn().mockResolvedValue(true),
}))

// Mock session service — track registered sessions
const registeredSessions = new Map<string, { name: string }>()

vi.mock('@shared/lib/services/session-service', () => ({
  registerSession: vi.fn(async (_agentSlug: string, sessionId: string, name?: string) => {
    registeredSessions.set(sessionId, { name: name || 'New Session' })
  }),
  updateSessionMetadata: vi.fn(),
  getSessionMetadata: vi.fn().mockResolvedValue(null),
}))

// Mock settings
vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveModels: () => ({
    agentModel: 'claude-sonnet-4-5',
    browserModel: 'claude-sonnet-4-5',
    summarizerModel: 'claude-haiku-4-5',
  }),
  getSettings: () => ({}),
}))

// Mock secrets service
vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: vi.fn().mockResolvedValue([]),
}))

// Use the real messagePersister — it handles the complex stream→SSE transformation

// Mock telegram connector to return our MockChatClientConnector
vi.mock('./telegram-connector', () => ({
  TelegramConnector: class {
    constructor() {
      return mockConnector
    }
  },
}))

// ── Imports (after mocks) ──────────────────────────────────────────────

import { chatIntegrationManager } from './chat-integration-manager'
import { createChatIntegration, getChatIntegration } from '@shared/lib/services/chat-integration-service'
import { listChatIntegrationSessions } from '@shared/lib/services/chat-integration-session-service'
import { approveChatAccess, revokeChatAccess } from '@shared/lib/services/chat-integration-access-service'
import { containerManager } from '@shared/lib/container/container-manager'
import { MockContainerClient } from '@shared/lib/container/mock-container-client'

// ── Helpers ────────────────────────────────────────────────────────────

function createTestIntegration(overrides?: Record<string, unknown>): string {
  const id = createChatIntegration({
    agentSlug: 'test-agent',
    provider: 'telegram',
    config: { botToken: 'test-token-123' },
    name: 'Test Bot',
    ...overrides,
  })
  // Telegram integrations now require owner approval by default (the access
  // allowlist gate). These tests exercise message-flow plumbing for an already
  // approved bot, not access control, so disable the gate for them.
  testSqlite.prepare('UPDATE chat_integrations SET require_approval = 0 WHERE id = ?').run(id)
  return id
}

function waitForCondition(
  check: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      if (check()) return resolve()
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for condition'))
      setTimeout(poll, intervalMs)
    }
    poll()
  })
}

// ── Setup / teardown ───────────────────────────────────────────────────

describe('Chat integration E2E', () => {
  beforeEach(async () => {
    // Fresh temp directory
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-e2e-test-'))
    process.env.SUPERAGENT_DATA_DIR = testDir

    // In-memory DB
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })

    // Fresh mock connector
    mockConnector = new MockChatClientConnector()

    // Fresh mock container client
    mockContainerClient = new MockContainerClient({
      agentId: 'test-agent',
    })
    await mockContainerClient.start()
    MockContainerClient.resetCallRecords();

    // Wire container manager mock
    (containerManager.ensureRunning as any).mockResolvedValue(mockContainerClient)

    registeredSessions.clear()
  })

  afterEach(async () => {
    chatIntegrationManager.stop()
    // Let pending async handlers drain before closing the DB
    await new Promise(r => setTimeout(r, 50))
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  // ── Tests ──────────────────────────────────────────────────────────

  describe('incoming message flow', () => {
    it('creates a session and gets a response for a new chat', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      // Simulate incoming message
      mockConnector.simulateIncomingMessage('Hello agent!', 'chat-1', 'user-1')

      // MockContainerClient should receive createSession with the message
      await waitForCondition(() => MockContainerClient.createSessionCalls.length > 0)
      expect(MockContainerClient.createSessionCalls[0].initialMessage).toBe('Hello agent!')

      // Wait for the mock scenario to produce a response back through the connector
      await waitForCondition(() => mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0, 3000)

      // The connector should have received at least one outgoing message (the response)
      const totalOutgoing = mockConnector.sentMessages.length + mockConnector.finalizedMessages.length
      expect(totalOutgoing).toBeGreaterThan(0)
    })

    it('reuses existing session for follow-up messages', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      // First message — creates session
      mockConnector.simulateIncomingMessage('First message', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length > 0)

      // Wait for response to complete before sending follow-up
      await waitForCondition(
        () => mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0,
        3000,
      )

      // Second message — should use sendMessage, not createSession
      mockConnector.simulateIncomingMessage('Follow-up message', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.sendMessageCalls.length > 0)

      expect(MockContainerClient.createSessionCalls).toHaveLength(1)
      expect(MockContainerClient.sendMessageCalls[0].content).toBe('Follow-up message')
    })

    it('creates separate sessions for different chats', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      // Message from chat-1
      mockConnector.simulateIncomingMessage('Hello from chat 1', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length === 1)
      await waitForCondition(
        () => mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0,
        3000,
      )

      // Message from chat-2
      mockConnector.simulateIncomingMessage('Hello from chat 2', 'chat-2', 'user-2')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length === 2)

      expect(MockContainerClient.createSessionCalls[0].initialMessage).toBe('Hello from chat 1')
      expect(MockContainerClient.createSessionCalls[1].initialMessage).toBe('Hello from chat 2')
    })

    it('escapes [userName] prefix so markdown does not swallow single-word messages', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      // Group chat: both chatName and userName set → prefix is added.
      // "Heyy" is a single word, so unescaped "[Alice]: Heyy" would be parsed
      // as a markdown link reference definition and render as empty text.
      mockConnector.simulateIncomingMessage('Heyy', 'group-1', 'user-1', {
        userName: 'Alice',
        chatName: '#general',
      })

      await waitForCondition(() => MockContainerClient.createSessionCalls.length > 0)

      const sent = MockContainerClient.createSessionCalls[0].initialMessage!
      // The bracket must be escaped so markdown renders it as visible text
      expect(sent).toBe('\\[Alice]: Heyy')
      expect(sent).not.toBe('[Alice]: Heyy')
    })
  })

  describe('/clear command', () => {
    it('resets the session so next message creates a new one', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      // First message — creates session
      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length === 1)
      await waitForCondition(
        () => mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0,
        3000,
      )

      // /clear — should acknowledge and tear down session
      const msgCountBefore = mockConnector.sentMessages.length
      mockConnector.simulateIncomingMessage('/clear', 'chat-1', 'user-1')
      await waitForCondition(() => mockConnector.sentMessages.length > msgCountBefore)

      // Next message should create a new session (not sendMessage)
      mockConnector.simulateIncomingMessage('After clear', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length === 2)

      expect(MockContainerClient.createSessionCalls[1].initialMessage).toBe('After clear')
    })
  })

  describe('session self-heal (container lost the session)', () => {
    it('archives the dead session and starts a fresh one instead of failing forever', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      // First message establishes a real session: DB row + live container session.
      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length === 1)
      await waitForCondition(
        () => mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0,
        3000,
      )

      // Simulate the container EVICTING the session (e.g. dev container recreated):
      // the DB row stays non-archived but the container no longer has the session,
      // so the next sendMessage 404s with "Session not found".
      const deadSessionId = [...(mockContainerClient as any).sessions.keys()][0] as string
      await mockContainerClient.deleteSession(deadSessionId)

      // Next message to the same chat — the manager should self-heal: archive the
      // dead row and transparently start a fresh session with the same message,
      // instead of dead-ending on every future message.
      mockConnector.simulateIncomingMessage('Still there?', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length === 2)

      // The user's message was carried into the fresh session as its first message.
      expect(MockContainerClient.createSessionCalls[1].initialMessage).toBe('Still there?')

      // The dead row is archived; a fresh non-archived row now serves this chat.
      const rows = listChatIntegrationSessions(integrationId).filter((r) => r.externalChatId === 'chat-1')
      const dead = rows.find((r) => r.sessionId === deadSessionId)
      const fresh = rows.find((r) => r.sessionId !== deadSessionId && !r.archivedAt)
      expect(dead?.archivedAt).toBeTruthy()
      expect(fresh).toBeDefined()
    })

    it('does NOT rotate the session on a transient (non-session-gone) error', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length === 1)
      await waitForCondition(
        () => mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0,
        3000,
      )

      const liveSessionId = [...(mockContainerClient as any).sessions.keys()][0] as string

      // Next send fails with a TRANSIENT error (not "session not found").
      const sendSpy = vi
        .spyOn(mockContainerClient, 'sendMessage')
        .mockRejectedValueOnce(new Error('Container is not running'))

      const createBefore = MockContainerClient.createSessionCalls.length
      const sentBefore = mockConnector.sentMessages.length
      mockConnector.simulateIncomingMessage('Transient please', 'chat-1', 'user-1')

      // Manager surfaces a retry prompt and does NOT rotate the session.
      await waitForCondition(
        () => mockConnector.sentMessages.slice(sentBefore).some((m) => /try again/i.test(m.message.text ?? '')),
        3000,
      )
      expect(MockContainerClient.createSessionCalls.length).toBe(createBefore)

      const rows = listChatIntegrationSessions(integrationId).filter((r) => r.externalChatId === 'chat-1')
      expect(rows.find((r) => r.sessionId === liveSessionId)?.archivedAt).toBeFalsy()

      sendSpy.mockRestore()
    })

    it('blocks the self-heal spend when the chat is revoked mid-flight', async () => {
      // Approval-required bot with chat-1 pre-approved (createTestIntegration
      // force-disables approval, so re-enable it to make the access gate live).
      const integrationId = createTestIntegration()
      testSqlite.prepare('UPDATE chat_integrations SET require_approval = 1 WHERE id = ?').run(integrationId)
      const accessId = crypto.randomUUID()
      const now = Date.now()
      testSqlite
        .prepare(
          `INSERT INTO chat_integration_access
             (id, integration_id, external_chat_id, chat_type, status, requested_at, created_at, updated_at)
           VALUES (?, ?, 'chat-1', 'private', 'pending', ?, ?, ?)`,
        )
        .run(accessId, integrationId, now, now, now)
      approveChatAccess(accessId, 'owner')

      await chatIntegrationManager.addIntegration(integrationId)

      // Establish a real session for the approved chat.
      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length === 1)
      await waitForCondition(
        () => mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0,
        3000,
      )

      const deadSessionId = [...(mockContainerClient as any).sessions.keys()][0] as string

      // The next send 404s with "Session not found" (→ self-heal) AND a revoke
      // lands during that same await. The self-heal must re-check access before
      // spending and bail — no fresh session for a chat that is no longer allowed.
      const sendSpy = vi.spyOn(mockContainerClient, 'sendMessage').mockImplementationOnce(async () => {
        revokeChatAccess(accessId, 'owner')
        throw new Error('Session not found')
      })

      mockConnector.simulateIncomingMessage('Are you there?', 'chat-1', 'user-1')

      // The self-heal archives the dead row before the access re-check; wait for
      // that so we know the self-heal path actually executed.
      await waitForCondition(() =>
        listChatIntegrationSessions(integrationId).some(
          (r) => r.sessionId === deadSessionId && !!r.archivedAt,
        ),
      )

      // Gate fired: dead row archived, but NO fresh session created (no spend),
      // so the now-revoked chat is left with no live session row.
      expect(sendSpy).toHaveBeenCalledTimes(1)
      expect(MockContainerClient.createSessionCalls.length).toBe(1)
      const liveRow = listChatIntegrationSessions(integrationId)
        .filter((r) => r.externalChatId === 'chat-1')
        .find((r) => !r.archivedAt)
      expect(liveRow).toBeUndefined()

      sendSpy.mockRestore()
    })
  })

  describe('outbound MCP send (shouldQuery: false)', () => {
    it('injects a notification into the live session without triggering a response', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      // Establish a session first
      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length === 1)
      await waitForCondition(
        () => mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0,
        3000,
      )

      // Get the session ID that was created
      const sessionId = MockContainerClient.createSessionCalls[0]
      expect(sessionId).toBeDefined()

      // Now simulate an outbound MCP send — call sendMessage with shouldQuery: false
      // This is what x-agent-chat /send route does
      const createdSessionId = (await mockContainerClient.getSession(
        [...(mockContainerClient as any).sessions.keys()][0],
      ))?.id

      expect(createdSessionId).toBeDefined()

      const callCountBefore = MockContainerClient.sendMessageCalls.length
      const outgoingCountBefore = mockConnector.sentMessages.length + mockConnector.finalizedMessages.length

      await mockContainerClient.sendMessage(
        createdSessionId!,
        '<<SYSTEM>> A message was sent to the user on your behalf: Hi from another agent',
        undefined,
        { shouldQuery: false },
      )

      // Should have recorded the call
      expect(MockContainerClient.sendMessageCalls.length).toBe(callCountBefore + 1)
      expect(MockContainerClient.sendMessageCalls.at(-1)!.content).toContain('Hi from another agent')

      // Should NOT have triggered a scenario response (no new messages from connector)
      // Give a small window to confirm nothing fires
      await new Promise(r => setTimeout(r, 200))
      const outgoingCountAfter = mockConnector.sentMessages.length + mockConnector.finalizedMessages.length
      expect(outgoingCountAfter).toBe(outgoingCountBefore)
    })
  })

  describe('connection lifecycle', () => {
    it('connector is connected after addIntegration', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      expect(chatIntegrationManager.isIntegrationConnected(integrationId)).toBe(true)
      expect(chatIntegrationManager.getActiveIntegrationIds()).toContain(integrationId)
    })

    it('connector is disconnected after removeIntegration', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      await chatIntegrationManager.removeIntegration(integrationId)

      expect(chatIntegrationManager.isIntegrationConnected(integrationId)).toBe(false)
      expect(chatIntegrationManager.getActiveIntegrationIds()).not.toContain(integrationId)
    })

    it('pause and resume work correctly', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      await chatIntegrationManager.pauseIntegration(integrationId)
      expect(chatIntegrationManager.isIntegrationConnected(integrationId)).toBe(false)
      const paused = getChatIntegration(integrationId)
      expect(paused?.status).toBe('paused')

      // Create a new mock connector for resume (old one is disconnected)
      mockConnector = new MockChatClientConnector()
      await chatIntegrationManager.resumeIntegration(integrationId)
      expect(chatIntegrationManager.isIntegrationConnected(integrationId)).toBe(true)
    })
  })

  describe('typing indicator', () => {
    it('shows typing indicator when message is being processed', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length > 0)

      // Follow-up triggers typing indicator
      await waitForCondition(
        () => mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0,
        3000,
      )
      mockConnector.simulateIncomingMessage('Another question', 'chat-1', 'user-1')
      await waitForCondition(() => mockConnector.typingIndicators.length > 0, 2000)

      expect(mockConnector.typingIndicators).toContain('chat-1')
    })

    it('re-arms the indicator the moment a request answer reaches the container', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      // Establish a live managed session for chat-1.
      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length > 0)
      await waitForCondition(
        () => mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0,
        3000,
      )

      // Isolate the re-arm: the agent answered a request, so the next startWorking
      // must come from the confirmed resolve — not from a stream_start.
      mockConnector.typingIndicators = []
      mockConnector.simulateInteractiveResponse('tu-1', { question: 'Q', answer: 'A' }, 'chat-1')

      await waitForCondition(() => mockConnector.typingIndicators.includes('chat-1'), 2000)
      expect(mockConnector.typingIndicators).toContain('chat-1')
    })

    it('settles the indicator when a proxy-review approval card is routed to chat', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      // Establish a live, working managed session for chat-1.
      mockConnector.simulateIncomingMessage('Do something privileged', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length > 0)
      await waitForCondition(() => listChatIntegrationSessions(integrationId).length > 0)
      const sessionId = listChatIntegrationSessions(integrationId)[0].sessionId

      // Mid-turn the agent blocks on a host-side tool approval (proxy review). That
      // card routes through the GLOBAL notification path, not per-session SSE, so it
      // would otherwise miss the session_awaiting_input settle and leave a perpetual
      // "Thinking…" until the 5-min watchdog.
      mockConnector.stoppedWorking = []
      await (chatIntegrationManager as unknown as {
        handleGlobalNotification: (e: unknown) => Promise<void>
      }).handleGlobalNotification({
        type: 'session_awaiting_input',
        sessionId,
        agentSlug: 'test-agent',
        review: { type: 'proxy_review_request', reviewId: 'rev-1', displayText: 'Allow GitHub?', toolkit: 'github' },
      })

      // The approval card is shown AND the indicator settles (no perpetual "Thinking…").
      expect(mockConnector.sentCards.some((c) => c.event.type === 'user_question_request')).toBe(true)
      expect(mockConnector.stoppedWorking).toContain('chat-1')
    })

    it('stops the working indicator when the integration is torn down', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      // Establish a live managed session for chat-1.
      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length > 0)
      await waitForCondition(
        () => mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0,
        3000,
      )

      // Ignore stopWorking from the normal stream transition; we only want to
      // prove the teardown path stops the indicator. Guards the round-1 leak fix
      // where clearing a session dropped it without stopping the keep-alive timer.
      mockConnector.stoppedWorking = []

      await chatIntegrationManager.removeIntegration(integrationId)

      expect(mockConnector.stoppedWorking).toContain('chat-1')
    })
  })
})

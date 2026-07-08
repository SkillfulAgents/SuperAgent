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
    getClient: vi.fn(),
    getCachedInfo: vi.fn(),
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

import { chatIntegrationManager, STALL_NUDGE_MS, STALL_NUDGE_TEXT } from './chat-integration-manager'
import { createChatIntegration, getChatIntegration } from '@shared/lib/services/chat-integration-service'
import { listChatIntegrationSessions } from '@shared/lib/services/chat-integration-session-service'
import { approveChatAccess, revokeChatAccess } from '@shared/lib/services/chat-integration-access-service'
import { containerManager } from '@shared/lib/container/container-manager'
import { MockContainerClient, SlowWorkScenario } from '@shared/lib/container/mock-container-client'
import { messagePersister } from '@shared/lib/container/message-persister'

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
    ;(containerManager.getClient as any).mockReturnValue(mockContainerClient)
    ;(containerManager.getCachedInfo as any).mockReturnValue({ status: 'running' })

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

  describe('/stop command', () => {
    async function startConversation(integrationId: string): Promise<string> {
      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      // Wait on the DB mapping itself (created AFTER the container call, so
      // createSessionCalls is not the right sync point), then let the mock turn
      // fully settle so no late scenario event races the test body (e.g. a
      // trailing session_idle un-doing a simulated hang).
      await waitForCondition(() =>
        listChatIntegrationSessions(integrationId).some(s => s.externalChatId === 'chat-1'))
      await waitForCondition(() =>
        mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0, 3000)
      return listChatIntegrationSessions(integrationId).find(s => s.externalChatId === 'chat-1')!.sessionId
    }

    it('interrupts an active turn, settles the session, and acks', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const sessionId = await startConversation(integrationId)

      // Simulate a hung turn: active in the persister, no terminal event coming
      messagePersister.markSessionActive(sessionId, 'test-agent')
      const interruptSpy = vi.spyOn(mockContainerClient, 'interruptSession')
      const dismissSpy = vi.spyOn(mockConnector, 'dismissOpenCards')

      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text === '⏹ Stopped. Send a message to start again.'))

      expect(interruptSpy).toHaveBeenCalledWith(sessionId)
      // Card hygiene: an open question card must not outlive the killed turn
      expect(dismissSpy).toHaveBeenCalledWith('chat-1')
      expect(messagePersister.isSessionActive(sessionId)).toBe(false)
      // The conversation mapping survives un-archived (unlike /clear)
      expect(listChatIntegrationSessions(integrationId).find(s => s.sessionId === sessionId)!.archivedAt).toBeNull()

      // And the next message runs as a fresh turn in the SAME conversation,
      // dispatched immediately (not queued behind the killed turn)
      const sendsBefore = MockContainerClient.sendMessageCalls.length
      mockConnector.simulateIncomingMessage('again', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.sendMessageCalls.length > sendsBefore)
      const followUp = MockContainerClient.sendMessageCalls.at(-1)!
      expect(followUp.sessionId).toBe(sessionId)
      expect(followUp.content).toContain('again')
    })

    it('accepts the Telegram group form /stop@botname', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const sessionId = await startConversation(integrationId)
      messagePersister.markSessionActive(sessionId, 'test-agent')

      mockConnector.simulateIncomingMessage('/stop@MyAgentBot', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text === '⏹ Stopped. Send a message to start again.'))

      expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    })

    it('acks "nothing running" after the previous turn completed', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const sessionId = await startConversation(integrationId)
      // The turn settled inside startConversation; nothing marks it active again
      const interruptSpy = vi.spyOn(mockContainerClient, 'interruptSession')

      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text === '⏹ Nothing is running right now.'))

      expect(interruptSpy).not.toHaveBeenCalled()
      expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    })

    it("leaves a sibling chat's running turn untouched", async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      // Two chats on one integration (and therefore one agent)
      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      await waitForCondition(() =>
        listChatIntegrationSessions(integrationId).some(s => s.externalChatId === 'chat-1'))
      mockConnector.simulateIncomingMessage('Hello', 'chat-2', 'user-2')
      await waitForCondition(() =>
        listChatIntegrationSessions(integrationId).some(s => s.externalChatId === 'chat-2'))
      const s1 = listChatIntegrationSessions(integrationId).find(s => s.externalChatId === 'chat-1')!.sessionId
      const s2 = listChatIntegrationSessions(integrationId).find(s => s.externalChatId === 'chat-2')!.sessionId
      // Let BOTH mock turns respond AND settle before simulating the hangs, so a
      // late scenario completion can't un-do a simulated active state
      const responded = (chatId: string) =>
        mockConnector.sentMessages.some(m => m.chatId === chatId) ||
        mockConnector.finalizedMessages.some(m => m.chatId === chatId)
      await waitForCondition(() =>
        responded('chat-1') && responded('chat-2') &&
        !messagePersister.isSessionActive(s1) && !messagePersister.isSessionActive(s2), 5000)

      messagePersister.markSessionActive(s1, 'test-agent')
      messagePersister.markSessionActive(s2, 'test-agent')

      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.chatId === 'chat-1' && m.message.text === '⏹ Stopped. Send a message to start again.'))

      expect(messagePersister.isSessionActive(s1)).toBe(false)
      expect(messagePersister.isSessionActive(s2)).toBe(true)
      // The ack went only to chat-1
      expect(mockConnector.sentMessages.some(m => m.chatId === 'chat-2' && m.message.text?.includes('Stopped'))).toBe(false)
    })

    it('suppresses a stale session_error notice racing the stop ack', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const sessionId = await startConversation(integrationId)

      messagePersister.markSessionActive(sessionId, 'test-agent')
      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text === '⏹ Stopped. Send a message to start again.'))
      const countAfterAck = mockConnector.sentMessages.length

      // A stale error event that was already in flight when /stop landed: it must
      // not produce a second, contradictory notice after the stop ack
      ;(messagePersister as unknown as { broadcastToSSE(id: string, data: unknown): void })
        .broadcastToSSE(sessionId, { type: 'session_error', apiErrorCode: null })
      await new Promise(r => setTimeout(r, 100))

      expect(mockConnector.sentMessages.length).toBe(countAfterAck)
    })

    it('acks gracefully when nothing is running', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const interruptSpy = vi.spyOn(mockContainerClient, 'interruptSession')

      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text === '⏹ Nothing is running right now.'))

      expect(interruptSpy).not.toHaveBeenCalled()
      // No session was created by the command
      expect(MockContainerClient.createSessionCalls).toHaveLength(0)
    })

    it('is blocked by the access gate for a non-approved chat', async () => {
      const integrationId = createTestIntegration()
      // Re-enable the approval gate that createTestIntegration disables
      testSqlite.prepare('UPDATE chat_integrations SET require_approval = 1 WHERE id = ?').run(integrationId)
      await chatIntegrationManager.addIntegration(integrationId)
      const interruptSpy = vi.spyOn(mockContainerClient, 'interruptSession')

      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      // Let the (gated) handler drain
      await new Promise(r => setTimeout(r, 100))

      expect(interruptSpy).not.toHaveBeenCalled()
      expect(mockConnector.sentMessages.some(m => m.message.text?.includes('Stopped'))).toBe(false)
    })

    it('settles locally when the container is not running', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const sessionId = await startConversation(integrationId)

      messagePersister.markSessionActive(sessionId, 'test-agent')
      ;(containerManager.getCachedInfo as any).mockReturnValue({ status: 'stopped' })
      const interruptSpy = vi.spyOn(mockContainerClient, 'interruptSession')

      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text === '⏹ Stopped. Send a message to start again.'))

      expect(interruptSpy).not.toHaveBeenCalled()
      expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    })

    it('a concurrent second /stop is a no-op (one interrupt, one ack, no "nothing running")', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const sessionId = await startConversation(integrationId)
      messagePersister.markSessionActive(sessionId, 'test-agent')

      // Hold the interrupt open so the first /stop parks mid-interrupt while the second
      // races the stopInFlight guard. The gate stays held through the flush below, so the
      // first can't settle and release the latch — without the guard the second would
      // pass the still-active gate and interrupt a second time.
      let releaseInterrupt: () => void = () => {}
      const interruptGate = new Promise<void>((r) => { releaseInterrupt = r })
      const interruptSpy = vi.spyOn(mockContainerClient, 'interruptSession').mockImplementation(async () => {
        await interruptGate
        return true
      })

      // Two /stops arrive together (double-tap, or a tap racing a typed /stop). The priority
      // lane dispatches both off the serial queue, so they reach stopChatTurn concurrently.
      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')

      // First /stop is now parked in the interrupt; flush the loop so the second reaches
      // (and is no-op'd by) the guard while the first still holds it.
      await waitForCondition(() => interruptSpy.mock.calls.length >= 1)
      for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
      expect(interruptSpy).toHaveBeenCalledTimes(1) // guard blocked the second interrupt

      releaseInterrupt()
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text === '⏹ Stopped. Send a message to start again.'))

      // Exactly one interrupt and one "Stopped" ack; never a contradictory "Nothing is running".
      expect(interruptSpy).toHaveBeenCalledTimes(1)
      expect(mockConnector.sentMessages.filter(m =>
        m.message.text === '⏹ Stopped. Send a message to start again.')).toHaveLength(1)
      expect(mockConnector.sentMessages.some(m =>
        m.message.text === '⏹ Nothing is running right now.')).toBe(false)
    })

    it('a /stop during a suspended follow-up send does not resurrect the stopped session', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const sessionId = await startConversation(integrationId)
      messagePersister.markSessionActive(sessionId, 'test-agent')

      // Park the follow-up's delivery so /stop interleaves while the send is suspended at
      // client.sendMessage — the exact window the priority lane opens. Without the epoch
      // guard, the send's markSessionActive on resume would re-activate the stopped turn.
      let releaseSend: () => void = () => {}
      const sendGate = new Promise<void>((r) => { releaseSend = r })
      const sendSpy = vi.spyOn(mockContainerClient, 'sendMessage').mockImplementation(async () => {
        await sendGate
      })

      // A normal follow-up enters the send path and parks at the gated send.
      mockConnector.simulateIncomingMessage('a follow-up while busy', 'chat-1', 'user-1')
      await waitForCondition(() => sendSpy.mock.calls.length >= 1)

      // /stop interrupts the active turn while the follow-up is still parked.
      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text === '⏹ Stopped. Send a message to start again.'))
      expect(messagePersister.isSessionActive(sessionId)).toBe(false)

      // Release the parked send: its markSessionActive must be skipped, so the session
      // stays stopped rather than snapping back to active.
      releaseSend()
      for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
      expect(messagePersister.isSessionActive(sessionId)).toBe(false)
    })

    it('a /stop before the follow-up is submitted abandons it (never reaches the container)', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const sessionId = await startConversation(integrationId)
      messagePersister.markSessionActive(sessionId, 'test-agent')

      // Park the follow-up in buildMessageContent — BEFORE the container send — so /stop
      // lands while the message has not yet been submitted. The pre-send epoch guard must
      // then abandon it: never call client.sendMessage, never re-activate.
      let releaseBuild: () => void = () => {}
      const buildGate = new Promise<void>((r) => { releaseBuild = r })
      // buildMessageContent lives on the manager SINGLETON (not recreated per test like
      // mockContainerClient), so this spy MUST be restored in the finally or it leaks into
      // later tests.
      const buildSpy = vi.spyOn(chatIntegrationManager as unknown as { buildMessageContent: () => Promise<unknown> }, 'buildMessageContent')
        .mockImplementation(async () => { await buildGate; return { text: 'a follow-up while busy', failedFiles: [] } })
      const sendSpy = vi.spyOn(mockContainerClient, 'sendMessage')
      try {
        mockConnector.simulateIncomingMessage('a follow-up while busy', 'chat-1', 'user-1')
        await waitForCondition(() => buildSpy.mock.calls.length >= 1)

        // /stop while the follow-up is parked before the send.
        mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
        await waitForCondition(() =>
          mockConnector.sentMessages.some(m => m.message.text === '⏹ Stopped. Send a message to start again.'))

        // Release the parked build: the message must be abandoned, not submitted, and the
        // session stays stopped.
        releaseBuild()
        for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
        expect(sendSpy).not.toHaveBeenCalled()
        expect(messagePersister.isSessionActive(sessionId)).toBe(false)
      } finally {
        releaseBuild()
        buildSpy.mockRestore()
      }
    })
  })

  describe('/clear on a busy session', () => {
    it('interrupts the running turn before archiving', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      // Same deterministic setup as the /stop tests: wait on the DB mapping,
      // then let the mock turn settle before simulating the hang.
      await waitForCondition(() =>
        listChatIntegrationSessions(integrationId).some(s => s.externalChatId === 'chat-1'))
      await waitForCondition(() =>
        mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0, 3000)
      const sessionId = listChatIntegrationSessions(integrationId).find(s => s.externalChatId === 'chat-1')!.sessionId

      messagePersister.markSessionActive(sessionId, 'test-agent')
      // Capture archive state AT interrupt time to pin the ordering, not just
      // that both happened
      let archivedAtInterruptTime: unknown = 'interrupt-never-ran'
      const interruptSpy = vi.spyOn(mockContainerClient, 'interruptSession').mockImplementation(async () => {
        archivedAtInterruptTime = listChatIntegrationSessions(integrationId).find(s => s.sessionId === sessionId)!.archivedAt
        return true
      })
      const dismissSpy = vi.spyOn(mockConnector, 'dismissOpenCards')

      mockConnector.simulateIncomingMessage('/clear', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text?.includes('Session cleared')))

      // Stop FIRST: the turn must not keep running orphaned after the mapping is
      // archived - at interrupt time the row was not yet archived
      expect(interruptSpy).toHaveBeenCalledWith(sessionId)
      expect(archivedAtInterruptTime).toBeNull()
      // Same card hygiene as /stop
      expect(dismissSpy).toHaveBeenCalledWith('chat-1')
      expect(messagePersister.isSessionActive(sessionId)).toBe(false)
      // And the clear still archived the mapping (listChatIntegrationSessions
      // intentionally returns archived rows too, so assert the flag itself)
      expect(listChatIntegrationSessions(integrationId).find(s => s.sessionId === sessionId)!.archivedAt).not.toBeNull()
    })
  })

  describe('stall nudge end-to-end', () => {
    // A turn that opens with a couple of stream events (10ms/50ms) then goes
    // COMPLETELY silent for an hour - the hung-turn signature. Registered per
    // test so it can't leak into other suites.
    beforeEach(() => {
      MockContainerClient.scenarios.set('hang forever', new SlowWorkScenario(60 * 60_000))
    })
    afterEach(() => {
      MockContainerClient.scenarios.delete('hang forever')
    })

    // Warm the full dispatch path under REAL timers: the manager lazy-imports
    // modules (container-manager, agent-service, interrupt-session), and vitest
    // module loading is real I/O that fake timers stall on first use.
    async function warmDispatchPath(integrationId: string): Promise<number> {
      mockConnector.simulateIncomingMessage('warmup', 'chat-0', 'user-0')
      await waitForCondition(() =>
        listChatIntegrationSessions(integrationId).some(s => s.externalChatId === 'chat-0'))
      await waitForCondition(() =>
        mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0, 3000)
      await import('@shared/lib/container/interrupt-session')
      return MockContainerClient.createSessionCalls.length
    }

    it('nudges exactly once after the silence threshold on a hung turn', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      const baselineSessions = await warmDispatchPath(integrationId)

      vi.useFakeTimers()
      try {
        mockConnector.simulateIncomingMessage('hang forever', 'chat-1', 'user-1')
        // Drive dispatch + the scenario's opening events (10ms/50ms)
        await vi.advanceTimersByTimeAsync(1000)
        expect(MockContainerClient.createSessionCalls.length).toBeGreaterThan(baselineSessions)

        // 7 minutes of total silence → exactly one nudge, with the locked copy
        await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)
        expect(mockConnector.sentMessages.filter(m => m.message.text === STALL_NUDGE_TEXT)).toHaveLength(1)

        // Latch: another full silence window never produces a second nudge
        await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)
        expect(mockConnector.sentMessages.filter(m => m.message.text === STALL_NUDGE_TEXT)).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('re-arms on restore: a mid-turn session re-subscribed after a reconnect still nudges', async () => {
      // The arm-if-busy cold snapshot in subscribeChatSession: a session that is
      // busy at re-subscribe time (the restart/reconnect shape) starts a fresh
      // countdown even though no dispatch ran in this process.
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      await waitForCondition(() =>
        listChatIntegrationSessions(integrationId).some(s => s.externalChatId === 'chat-1'))
      await waitForCondition(() =>
        mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0, 3000)
      const sessionId = listChatIntegrationSessions(integrationId).find(s => s.externalChatId === 'chat-1')!.sessionId

      // The turn hangs, and the integration reconnects mid-turn
      messagePersister.markSessionActive(sessionId, 'test-agent')
      await chatIntegrationManager.removeIntegration(integrationId)

      vi.useFakeTimers()
      try {
        await chatIntegrationManager.addIntegration(integrationId)
        await vi.advanceTimersByTimeAsync(1000)

        await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS)
        expect(mockConnector.sentMessages.filter(m => m.message.text === STALL_NUDGE_TEXT)).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('never nudges a healthy long turn that emits periodic events', async () => {
      // Pins the SYNCHRONOUS reset wiring in the addSSEClient callback: a turn
      // that is LONG but never 7-min-silent must not nudge. Without the reset,
      // the dispatch-time arm fires at 7 minutes and this test goes red.
      MockContainerClient.scenarios.set('heartbeat work', {
        execute(sessionId: string, client: MockContainerClient) {
          // Same opening shape as SlowWorkScenario, then a heartbeat every
          // minute for 16 minutes, then a clean finish.
          setTimeout(() => {
            client.emitStreamMessage(sessionId, {
              type: 'stream_event',
              content: { type: 'stream_event', event: { type: 'message_start' } },
            })
            client.emitStreamMessage(sessionId, {
              type: 'stream_event',
              content: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
            })
          }, 50)
          for (let i = 1; i <= 16; i++) {
            setTimeout(() => {
              client.emitStreamMessage(sessionId, {
                type: 'stream_event',
                content: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `tick ${i} ` } } },
              })
            }, i * 60_000)
          }
          setTimeout(() => {
            client.emitStreamMessage(sessionId, {
              type: 'result',
              content: { type: 'result', subtype: 'success' },
            })
          }, 17 * 60_000)
        },
      })
      try {
        const integrationId = createTestIntegration()
        await chatIntegrationManager.addIntegration(integrationId)
        await warmDispatchPath(integrationId)

        vi.useFakeTimers()
        try {
          mockConnector.simulateIncomingMessage('heartbeat work', 'chat-1', 'user-1')
          await vi.advanceTimersByTimeAsync(1000)

          // 16 minutes - far past STALL_NUDGE_MS - with an event every minute
          await vi.advanceTimersByTimeAsync(16 * 60_000)
          expect(mockConnector.sentMessages.filter(m => m.message.text === STALL_NUDGE_TEXT)).toHaveLength(0)
        } finally {
          vi.useRealTimers()
        }
      } finally {
        MockContainerClient.scenarios.delete('heartbeat work')
      }
    })

    it('/stop cancels the pending nudge', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      await warmDispatchPath(integrationId)

      vi.useFakeTimers()
      try {
        mockConnector.simulateIncomingMessage('hang forever', 'chat-1', 'user-1')
        await vi.advanceTimersByTimeAsync(1000)

        mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
        await vi.advanceTimersByTimeAsync(1000)
        expect(mockConnector.sentMessages.some(m => m.message.text === '⏹ Stopped. Send a message to start again.')).toBe(true)

        // Well past the threshold: the cancelled timer must never fire
        await vi.advanceTimersByTimeAsync(STALL_NUDGE_MS * 2)
        expect(mockConnector.sentMessages.some(m => m.message.text === STALL_NUDGE_TEXT)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
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

    it('does NOT self-heal a stopped turn back into a fresh session', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)

      mockConnector.simulateIncomingMessage('Hello', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length === 1)
      await waitForCondition(
        () => mockConnector.sentMessages.length > 0 || mockConnector.finalizedMessages.length > 0,
        3000,
      )
      const sessionId = listChatIntegrationSessions(integrationId).find(s => s.externalChatId === 'chat-1')!.sessionId
      messagePersister.markSessionActive(sessionId, 'test-agent')

      // The follow-up's send parks, then fails session-gone (which normally triggers
      // self-heal → a fresh session with the same message). A /stop lands while it's parked:
      // the self-heal epoch guard must then ABANDON it, not recreate the stopped turn.
      let releaseSend: () => void = () => {}
      const sendGate = new Promise<void>((r) => { releaseSend = r })
      const sendSpy = vi.spyOn(mockContainerClient, 'sendMessage').mockImplementation(async () => {
        await sendGate
        throw new Error('Session not found')
      })
      const createBefore = MockContainerClient.createSessionCalls.length

      mockConnector.simulateIncomingMessage('a follow-up while busy', 'chat-1', 'user-1')
      await waitForCondition(() => sendSpy.mock.calls.length >= 1)

      mockConnector.simulateIncomingMessage('/stop', 'chat-1', 'user-1')
      await waitForCondition(() =>
        mockConnector.sentMessages.some(m => m.message.text === '⏹ Stopped. Send a message to start again.'))

      // Release the parked send → it rejects session-gone → self-heal path → the epoch guard
      // abandons it: NO fresh session is created for the message the user stopped.
      releaseSend()
      for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
      expect(MockContainerClient.createSessionCalls.length).toBe(createBefore)
      expect(messagePersister.isSessionActive(sessionId)).toBe(false)

      sendSpy.mockRestore()
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

    it('reconciles the indicator from the snapshot on subscribe (cold-start)', async () => {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      mockConnector.simulateIncomingMessage('hi', 'chat-1', 'user-1')
      await waitForCondition(() => MockContainerClient.createSessionCalls.length > 0)
      await waitForCondition(() => mockConnector.typingIndicators.includes('chat-1'), 2000)
      expect(mockConnector.typingIndicators).toContain('chat-1') // came up via snapshot or event
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

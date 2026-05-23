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
import { containerManager } from '@shared/lib/container/container-manager'
import { MockContainerClient } from '@shared/lib/container/mock-container-client'

// ── Helpers ────────────────────────────────────────────────────────────

function createTestIntegration(overrides?: Record<string, unknown>): string {
  return createChatIntegration({
    agentSlug: 'test-agent',
    provider: 'telegram',
    config: { botToken: 'test-token-123' },
    name: 'Test Bot',
    ...overrides,
  })
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
  })
})

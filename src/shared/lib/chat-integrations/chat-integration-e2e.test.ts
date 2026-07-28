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
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('not-automation')),
}))

// Mock settings. The capability + script-type reads belong to the persister's
// request path, which the wire-contract suite below drives for real.
const mockAgentCapabilities: Record<'subagents' | 'workflows', 'allow' | 'review' | 'block'> = {
  subagents: 'allow',
  workflows: 'allow',
}
vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveModels: () => ({
    agentModel: 'claude-sonnet-4-5',
    browserModel: 'claude-sonnet-4-5',
    summarizerModel: 'claude-haiku-4-5',
  }),
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ ...mockAgentCapabilities }),
  getModelCatalogSettings: () => ({}),
  VALID_SCRIPT_TYPES: {
    darwin: ['applescript', 'shell'],
    linux: ['shell'],
    win32: ['powershell'],
  },
}))

// Mock secrets service
vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: vi.fn().mockResolvedValue([]),
}))

// Use the real messagePersister — it handles the complex stream→SSE transformation

// Mock telegram connector to return our MockChatClientConnector. Keep the REAL
// classifyChatId static: the manager resolves the connector CLASS through this
// module for classification, so stripping it would silently disable attribution.
vi.mock('./telegram-connector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./telegram-connector')>()
  return {
    ...actual,
    TelegramConnector: class {
      static classifyChatId = actual.TelegramConnector.classifyChatId
      constructor() {
        return mockConnector
      }
    },
  }
})

// ── Imports (after mocks) ──────────────────────────────────────────────

import { chatIntegrationManager } from './chat-integration-manager'
import { createChatIntegration, getChatIntegration } from '@shared/lib/services/chat-integration-service'
import { listChatIntegrationSessions } from '@shared/lib/services/chat-integration-session-service'
import { approveChatAccess, revokeChatAccess } from '@shared/lib/services/chat-integration-access-service'
import { containerManager } from '@shared/lib/container/container-manager'
import { MockContainerClient, UserInputRequestScenario } from '@shared/lib/container/mock-container-client'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'

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

    // connectIntegration cancels itself on a stopped manager; this harness
    // drives addIntegration directly (no start()), so mark the manager running.
    ;(chatIntegrationManager as unknown as { isRunning: boolean }).isRunning = true
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

      // Group/supergroup: Telegram encodes that in a negative chat id. Prefix
      // is added from the provider rule, not from chatName presence.
      // "Heyy" is a single word, so unescaped "[Alice]: Heyy" would be parsed
      // as a markdown link reference definition and render as empty text.
      mockConnector.simulateIncomingMessage('Heyy', '-1001234567890', 'user-1', {
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

  // ────────────────────────────────────────────────────────────────────
  // Unified wire contract.
  //
  // Every other chat test around user-input requests hands processSSEEvent a
  // hand-built event and asserts what the connector does with it — which stays
  // green even if the host stops emitting the event entirely. These rows drive
  // a REAL tool_use through the REAL MessagePersister and assert on the card
  // that comes out the far end of the chat manager. If the registry stops
  // registering a kind, stops broadcasting it, or maps it to the wrong card,
  // exactly one row goes red and it names the kind.
  // ────────────────────────────────────────────────────────────────────

  describe('unified wire contract (persister → registry → chat card)', () => {
    interface WireRow {
      kind: string
      trigger: string
      cardType: string
      expect?: Record<string, unknown>
      /** Capability kinds only surface when the capability is set to review. */
      capability?: 'subagents' | 'workflows'
    }

    const WIRE_ROWS: WireRow[] = [
      { kind: 'secret', trigger: 'ask secret', cardType: 'secret_request', expect: { secretName: 'OPENAI_API_KEY' } },
      { kind: 'question', trigger: 'ask question', cardType: 'question_request' },
      { kind: 'connected_account', trigger: 'ask account', cardType: 'connected_account_request' },
      { kind: 'remote_mcp', trigger: 'request mcp', cardType: 'remote_mcp_request' },
      { kind: 'script_run', trigger: 'ask script', cardType: 'script_run_request', expect: { scriptType: process.platform === 'win32' ? 'powershell' : 'shell' } },
      { kind: 'file', trigger: 'need a file', cardType: 'file_request', expect: { description: 'A CSV of last quarter' } },
      { kind: 'browser_input', trigger: 'need browser help', cardType: 'browser_input_request', expect: { message: 'Please sign in' } },
      { kind: 'capability_review', trigger: 'launch subagent', cardType: 'capability_review_request', capability: 'subagents' },
    ]

    let originalE2eMock: string | undefined

    beforeEach(() => {
      // Computer-use interception is platform-gated with this escape hatch, and
      // the capability rows need the gate armed too.
      originalE2eMock = process.env.E2E_MOCK
      process.env.E2E_MOCK = 'true'
      mockAgentCapabilities.subagents = 'allow'
      mockAgentCapabilities.workflows = 'allow'
      userInputRequestManager.reset()

      // mockResolvedValue sets the DEFAULT but does not drain queued
      // *Once implementations — an unconsumed one from a timed-out test
      // would fire in the next one.
      vi.mocked(containerManager.ensureRunning).mockReset()
      vi.mocked(containerManager.ensureRunning).mockResolvedValue(mockContainerClient)

      // start() arms this in production; this harness drives addIntegration
      // directly, and without it the review card has no wire to arrive on.
      ;(chatIntegrationManager as unknown as { subscribeGlobalNotifications(): void })
        .subscribeGlobalNotifications()

      // Two kinds the shared scenario table has no trigger for.
      MockContainerClient.registerScenario('need a file', new UserInputRequestScenario([
        { name: 'mcp__user-input__request_file', input: { description: 'A CSV of last quarter' } },
      ]))
      MockContainerClient.registerScenario('need browser help', new UserInputRequestScenario([
        { name: 'mcp__user-input__request_browser_input', input: { message: 'Please sign in', requirements: ['credentials'] } },
      ]))
    })

    afterEach(() => {
      if (originalE2eMock === undefined) delete process.env.E2E_MOCK
      else process.env.E2E_MOCK = originalE2eMock
    })

    /** Drive one turn and return the first card the connector was handed. */
    async function cardFor(trigger: string) {
      const integrationId = createTestIntegration()
      await chatIntegrationManager.addIntegration(integrationId)
      mockConnector.simulateIncomingMessage(trigger, 'chat-1', 'user-1')
      await waitForCondition(() => mockConnector.sentCards.length > 0, 8000)
      return mockConnector.sentCards[0]
    }

    it.each(WIRE_ROWS)('a real $kind tool_use reaches chat as $cardType', async (row) => {
      if (row.capability) mockAgentCapabilities[row.capability] = 'review'

      const sent = await cardFor(row.trigger)

      expect(sent.event.type).toBe(row.cardType)
      expect(sent.chatId).toBe('chat-1')
      // The card must carry the session it came from: the "finish this in the
      // app" notice links it, and a card linking a rotated-away session sends
      // the user to the wrong place.
      expect(sent.sessionId).toBeTruthy()
      // …and it must be the id the registry holds, not a chat-side invention.
      const open = userInputRequestManager.getOpenRequest(
        (sent.event as { toolUseId: string }).toolUseId,
      )
      expect(open?.kind).toBe(row.kind)
      expect(open?.scope.sessionId).toBe(sent.sessionId)
      if (row.expect) expect(sent.event).toMatchObject(row.expect)
    })

    it('a parked proxy review reaches chat as the Allow/Deny card off the global wire', async () => {
      // Reviews are agent-scoped, so they never touch a session SSE stream —
      // this is the only path that carries them, and it is a different one from
      // every row above.
      const sent = await cardFor('proxy review please')

      expect(sent.event.type).toBe('question_request')
      const toolUseId = (sent.event as { toolUseId: string }).toolUseId
      expect(toolUseId).toMatch(/^review:[^:]+:test-agent$/)
      const labels = ((sent.event as { questions: Array<{ options?: Array<{ label: string }> }> }).questions[0].options ?? [])
        .map((o) => o.label)
      expect(labels).toEqual(['✅ Allow', '❌ Deny'])
      // The id in the card is the registry's review id, so the decision routes
      // back to the entry that is actually parked.
      const reviewId = toolUseId.split(':')[1]
      expect(userInputRequestManager.getOpenRequest(reviewId)?.kind).toBe('proxy_review')
    })

    it('a press on a card settled elsewhere is refused instead of buffered in the container', async () => {
      const sent = await cardFor('ask secret')
      const toolUseId = (sent.event as { toolUseId: string }).toolUseId

      // Settled in the app while the chat card still shows live buttons.
      expect(userInputRequestManager.resolve(toolUseId, 'answered')).not.toBeNull()

      const fetchSpy = vi.spyOn(mockContainerClient, 'fetch')
      mockConnector.sentMessages = []
      mockConnector.simulateInteractiveResponse(toolUseId, 'hunter2', 'chat-1')
      await waitForCondition(() => mockConnector.sentMessages.length > 0, 3000)

      expect(mockConnector.sentMessages[0].message.text).toContain('already handled')
      // The container must never see it: a resolve for an id nothing is waiting
      // on buffers an earlyResult that no tool will ever collect.
      expect(fetchSpy.mock.calls.filter(([p]) => String(p).includes('/resolve'))).toHaveLength(0)
      fetchSpy.mockRestore()
    })

    it('a press on another agent\'s open request is refused the same way', async () => {
      const sent = await cardFor('ask secret')
      const toolUseId = (sent.event as { toolUseId: string }).toolUseId

      // Same id, re-parked under a different agent — the shape a forged or
      // crossed-wires payload takes. Still open, still not this chat's to decide.
      userInputRequestManager.resolve(toolUseId, 'cancelled')
      userInputRequestManager.register({
        id: toolUseId,
        kind: 'secret',
        scope: { agentSlug: 'other-agent', sessionId: 'other-session' },
        blocking: true,
        autoApproved: false,
        payload: { secretName: 'OPENAI_API_KEY' },
      })

      const fetchSpy = vi.spyOn(mockContainerClient, 'fetch')
      mockConnector.sentMessages = []
      mockConnector.simulateInteractiveResponse(toolUseId, 'hunter2', 'chat-1')
      await waitForCondition(() => mockConnector.sentMessages.length > 0, 3000)

      expect(mockConnector.sentMessages[0].message.text).toContain('already handled')
      expect(fetchSpy.mock.calls.filter(([p]) => String(p).includes('/resolve'))).toHaveLength(0)
      expect(userInputRequestManager.getOpenRequest(toolUseId)).not.toBeNull()
      fetchSpy.mockRestore()
    })

    it('a settle that lands while ensureRunning is pending stops the container call', async () => {
      // The check-then-act window. Reading "is it open?" and then awaiting the
      // container lookup leaves a gap in which another surface can settle the
      // request; resolving after that buffers an earlyResult in a container
      // with nothing parked, and the chat user is told nothing.
      const sent = await cardFor('ask secret')
      const toolUseId = (sent.event as { toolUseId: string }).toolUseId

      let releaseContainer = () => {}
      const gate = new Promise<void>((resolve) => {
        releaseContainer = resolve
      })
      vi.mocked(containerManager.ensureRunning).mockImplementationOnce(async () => {
        await gate
        return mockContainerClient
      })

      const fetchSpy = vi.spyOn(mockContainerClient, 'fetch')
      mockConnector.sentMessages = []
      mockConnector.simulateInteractiveResponse(toolUseId, 'hunter2', 'chat-1')

      // Settle in the app while the press is parked on the container lookup.
      await waitForCondition(() => vi.mocked(containerManager.ensureRunning).mock.calls.length > 0, 3000)
      expect(userInputRequestManager.resolve(toolUseId, 'answered')).not.toBeNull()
      releaseContainer()

      // Wait on something BOTH outcomes produce, so the assertion below is what
      // fails when the gate regresses — not the wait. Gated: an already-handled
      // reply. Racy: a resolve posted to a container with nothing parked.
      const resolveCalls = () => fetchSpy.mock.calls.filter(([p]) => String(p).includes('/resolve'))
      await waitForCondition(
        () => mockConnector.sentMessages.length > 0 || resolveCalls().length > 0,
        3000,
      )
      expect(resolveCalls()).toHaveLength(0)
      expect(mockConnector.sentMessages[0]?.message.text).toContain('already handled')
      fetchSpy.mockRestore()
    })

    it('a failed decision releases the claim so the request stays decidable', async () => {
      // A leaked claim is worse than the race: the card would stay up forever
      // with every press refused.
      const sent = await cardFor('ask secret')
      const toolUseId = (sent.event as { toolUseId: string }).toolUseId

      vi.mocked(containerManager.ensureRunning).mockRejectedValueOnce(new Error('container down'))
      mockConnector.sentMessages = []
      mockConnector.simulateInteractiveResponse(toolUseId, 'hunter2', 'chat-1')
      await waitForCondition(
        () => vi.mocked(containerManager.ensureRunning).mock.calls.length > 0,
        3000,
      )

      await waitForCondition(() => userInputRequestManager.stats.claimed === 0, 3000)
      // Still open, and the next press gets through.
      expect(userInputRequestManager.getOpenRequest(toolUseId)).not.toBeNull()
      const fetchSpy = vi.spyOn(mockContainerClient, 'fetch')
      mockConnector.simulateInteractiveResponse(toolUseId, 'hunter2', 'chat-1')
      await waitForCondition(
        () => fetchSpy.mock.calls.some(([p]) => String(p).includes('/resolve')),
        3000,
      )
      fetchSpy.mockRestore()
    })

    it('a press on a genuinely open request still resolves the container', async () => {
      // The negative tests above are only meaningful if the positive path works.
      const sent = await cardFor('ask secret')
      const toolUseId = (sent.event as { toolUseId: string }).toolUseId

      const fetchSpy = vi.spyOn(mockContainerClient, 'fetch')
      mockConnector.simulateInteractiveResponse(toolUseId, 'hunter2', 'chat-1')

      await waitForCondition(
        () => fetchSpy.mock.calls.some(([p]) => String(p).includes('/resolve')),
        3000,
      )
      fetchSpy.mockRestore()
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

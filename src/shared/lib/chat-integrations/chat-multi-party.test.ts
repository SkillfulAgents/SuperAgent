/**
 * Multi-party attribution: each provider classifies the chat; a shared
 * projection decides whether to prefix the sender name.
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
import { isMultiPartyChatType, type ChatConnectorClass } from './base-connector'

// ── Test state ─────────────────────────────────────────────────────────

let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>
let mockConnector: MockChatClientConnector
let mockContainerClient: InstanceType<typeof MockContainerClient>

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
  runWithOptionalUser: (_userId: string | undefined, fn: () => unknown) => fn(),
}))

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    ensureRunning: vi.fn(),
  },
}))

vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: vi.fn().mockResolvedValue(true),
}))

vi.mock('@shared/lib/services/session-service', () => ({
  registerSession: vi.fn().mockResolvedValue(undefined),
  updateSessionMetadata: vi.fn().mockResolvedValue(undefined),
  getSessionMetadata: vi.fn().mockResolvedValue(null),
  finalizeAutomationStatus: vi.fn().mockResolvedValue('not-automation'),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveModels: () => ({
    agentModel: 'claude-sonnet-4-20250514',
    browserModel: 'claude-sonnet-4-20250514',
  }),
  getSettings: () => ({}),
}))

vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: vi.fn().mockResolvedValue([]),
}))

vi.mock('@shared/lib/services/agent-preferences-service', () => ({
  readAgentPreferences: vi.fn().mockResolvedValue({}),
}))

// Preserve real classifyChatId statics: the manager resolves the connector
// CLASS through these modules for attribution.
vi.mock('./slack-connector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./slack-connector')>()
  return {
    ...actual,
    SlackConnector: class {
      static generateSystemPrompt = actual.SlackConnector.generateSystemPrompt
      static classifyChatId = actual.SlackConnector.classifyChatId
      constructor() {
        return mockConnector
      }
    },
  }
})

vi.mock('./imessage-connector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./imessage-connector')>()
  return {
    ...actual,
    IMessageConnector: class {
      static generateSystemPrompt = actual.IMessageConnector.generateSystemPrompt
      static classifyChatId = actual.IMessageConnector.classifyChatId
      constructor() {
        return mockConnector
      }
    },
  }
})

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
import { classifySlackChat } from './slack-connector'
import { classifyTelegramChat } from './telegram-connector'
import { classifyIMessageChat } from './imessage-connector'
import { createChatIntegration } from '@shared/lib/services/chat-integration-service'
import { containerManager } from '@shared/lib/container/container-manager'
import { MockContainerClient } from '@shared/lib/container/mock-container-client'
import { parseSenderPrefix } from '@shared/lib/utils/sender-prefix'

// ── Helpers ────────────────────────────────────────────────────────────

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

function multiPartyFrom(classify: ChatConnectorClass['classifyChatId'], chat: { chatId: string; chatName?: string }): boolean {
  return isMultiPartyChatType(classify?.(chat))
}

// ── Per-provider classify → multi-party projection ─────────────────────

describe('classify → isMultiPartyChatType', () => {
  it.each([
    ['Slack DM', multiPartyFrom(classifySlackChat, { chatId: 'D0AAA111' }), false],
    ['Slack channel', multiPartyFrom(classifySlackChat, { chatId: 'C0BBB222', chatName: '#office' }), true],
    ['Slack channel with no chatName', multiPartyFrom(classifySlackChat, { chatId: 'C0BBB222' }), true],
    ['iMessage with chat name', multiPartyFrom(classifyIMessageChat, { chatId: '+15559876543', chatName: 'Family' }), true],
    ['iMessage without chat name', multiPartyFrom(classifyIMessageChat, { chatId: '+15559876543' }), false],
    [
      'connector class with no classify',
      multiPartyFrom(({} as ChatConnectorClass).classifyChatId, { chatId: 'x', chatName: 'Group' }),
      false,
    ],
  ] as const)('%s → %s', (_label, actual, expected) => {
    expect(actual).toBe(expected)
  })
})

// ── Message-builder path (Telegram DM vs group) ────────────────────────

describe('Telegram multi-party attribution via message builder', () => {
  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-multi-party-'))
    process.env.SUPERAGENT_DATA_DIR = testDir

    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })

    mockConnector = new MockChatClientConnector()
    mockContainerClient = new MockContainerClient({ agentId: 'test-agent' })
    await mockContainerClient.start()
    MockContainerClient.resetCallRecords()

    ;(containerManager.ensureRunning as ReturnType<typeof vi.fn>).mockResolvedValue(mockContainerClient)
    ;(chatIntegrationManager as unknown as { isRunning: boolean }).isRunning = true
  })

  afterEach(async () => {
    chatIntegrationManager.stop()
    await new Promise(r => setTimeout(r, 50))
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  it('attaches nothing for a Telegram DM even when chatName is the sender name, and attaches the name for a group', async () => {
    const integrationId = createChatIntegration({
      agentSlug: 'test-agent',
      provider: 'telegram',
      config: { botToken: 'test-token-123' },
      name: 'Test Bot',
    })
    testSqlite.prepare('UPDATE chat_integrations SET require_approval = 0 WHERE id = ?').run(integrationId)
    await chatIntegrationManager.addIntegration(integrationId)

    // Telegram fills chatName with the sender's own name in a private chat.
    mockConnector.simulateIncomingMessage('hey', '123456789', 'user-1', {
      userName: 'Jeremy',
      chatName: 'Jeremy',
    })
    await waitForCondition(() => MockContainerClient.createSessionCalls.length === 1)
    const dmText = MockContainerClient.createSessionCalls[0].initialMessage!
    expect(dmText).toBe('hey')
    expect(parseSenderPrefix(dmText)).toEqual({ sender: null, cleanText: 'hey' })
    expect(isMultiPartyChatType(classifyTelegramChat({ chatId: '123456789', chatName: 'Jeremy' }))).toBe(false)

    mockConnector.simulateIncomingMessage('hey', '-1001234567890', 'user-2', {
      userName: 'Alice',
      chatName: 'Team Chat',
    })
    await waitForCondition(() => MockContainerClient.createSessionCalls.length === 2)
    const groupText = MockContainerClient.createSessionCalls[1].initialMessage!
    expect(groupText).toBe('\\[Alice]: hey')
    expect(isMultiPartyChatType(classifyTelegramChat({ chatId: '-1001234567890', chatName: 'Team Chat' }))).toBe(true)
  })
})

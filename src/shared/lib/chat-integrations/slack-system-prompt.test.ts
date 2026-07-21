/**
 * Slack session system prompt tests.
 *
 * A Slack chat session must be told what it is: which conversation it serves
 * (DM vs channel vs thread) and that its transcript streams straight into that
 * conversation. Without this context an agent can treat the transcript as
 * private narration and reply through send_chat_message instead — guessing a
 * chat target and misrouting DMs.
 *
 * Covers the pure prompt builder and, via the e2e harness wiring
 * (MockChatClientConnector → ChatIntegrationManager → MockContainerClient),
 * that createSession receives the prompt for slack sessions only.
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

// Both connector classes return the shared mock so one harness drives slack
// and telegram integrations alike. The slack mock keeps the REAL static
// generateSystemPrompt (and the module's other exports): the manager resolves
// the connector CLASS through this module for static capability lookups, so
// stripping the static would silently disable the very wiring under test.
vi.mock('./slack-connector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./slack-connector')>()
  return {
    ...actual,
    SlackConnector: class {
      static generateSystemPrompt = actual.SlackConnector.generateSystemPrompt
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
      constructor() {
        return mockConnector
      }
    },
  }
})

vi.mock('./telegram-connector', () => ({
  TelegramConnector: class {
    constructor() {
      return mockConnector
    }
  },
}))

// ── Imports (after mocks) ──────────────────────────────────────────────

import { chatIntegrationManager } from './chat-integration-manager'
import { buildSlackSystemPrompt } from './slack-connector'
import { createChatIntegration } from '@shared/lib/services/chat-integration-service'
import { containerManager } from '@shared/lib/container/container-manager'
import { MockContainerClient } from '@shared/lib/container/mock-container-client'

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

// ── Pure builder ───────────────────────────────────────────────────────

describe('buildSlackSystemPrompt', () => {
  it('describes a direct message conversation when there is no channel name', () => {
    const prompt = buildSlackSystemPrompt({ chatId: 'D0AAA111', userName: 'Iddo Gino' })
    expect(prompt).toContain('a direct message conversation with Iddo Gino')
    expect(prompt).toContain('chat id: D0AAA111')
    // DM prompts must not describe multi-party attribution prefixes
    expect(prompt).not.toContain('[Jane Doe]')
  })

  it('describes the channel and the attribution prefix for channel sessions', () => {
    const prompt = buildSlackSystemPrompt({ chatId: 'C0BBB222', chatName: '#office', userName: 'Iddo Gino' })
    expect(prompt).toContain('the channel #office')
    expect(prompt).toContain('[Jane Doe]')
  })

  it('describes a thread via the composite chat id', () => {
    const prompt = buildSlackSystemPrompt({ chatId: 'C0BBB222|1784571878.344849', chatName: '#office', userName: 'Mike Reid' })
    expect(prompt).toContain('a message thread in #office')
    expect(prompt).toContain('chat id: C0BBB222|1784571878.344849')
    expect(prompt).toContain('[Jane Doe]')
  })

  it('falls back to the channel id when a thread message has no resolved channel name', () => {
    const prompt = buildSlackSystemPrompt({ chatId: 'C0BBB222|1784571878.344849' })
    expect(prompt).toContain('a message thread in channel C0BBB222')
  })

  it('still classifies an unnamed top-level channel as a channel, not a DM', () => {
    // resolveChannelName returns undefined when conversations.info fails, so a
    // missing chatName must not demote a channel to DM treatment.
    const prompt = buildSlackSystemPrompt({ chatId: 'C0BBB222', userName: 'Iddo Gino' })
    expect(prompt).toContain('a channel (id C0BBB222)')
    expect(prompt).not.toContain('direct message conversation')
    expect(prompt).toContain('[Jane Doe]')
  })

  it('classifies unnamed private groups (G-prefix) as group contexts', () => {
    const prompt = buildSlackSystemPrompt({ chatId: 'G0CCC333', userName: 'Iddo Gino' })
    expect(prompt).toContain('a channel (id G0CCC333)')
    expect(prompt).toContain('[Jane Doe]')
  })

  it('always explains automatic delivery and forbids self-sends', () => {
    for (const message of [
      { chatId: 'D0AAA111', userName: 'Iddo Gino' },
      { chatId: 'C0BBB222', chatName: '#office', userName: 'Iddo Gino' },
    ]) {
      const prompt = buildSlackSystemPrompt(message)
      expect(prompt).toContain('delivered automatically')
      expect(prompt).toContain('Never use send_chat_message to reply to this conversation')
    }
  })
})

// ── createSession pass-through ─────────────────────────────────────────

describe('slack session system prompt wiring', () => {
  let createSessionSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-slack-prompt-test-'))
    process.env.SUPERAGENT_DATA_DIR = testDir

    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })

    mockConnector = new MockChatClientConnector()

    mockContainerClient = new MockContainerClient({ agentId: 'test-agent' })
    await mockContainerClient.start()
    MockContainerClient.resetCallRecords()
    createSessionSpy = vi.spyOn(mockContainerClient, 'createSession') as ReturnType<typeof vi.spyOn>;

    (containerManager.ensureRunning as ReturnType<typeof vi.fn>).mockResolvedValue(mockContainerClient)

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

  const TEST_CONFIGS = {
    slack: { botToken: 'xoxb-test', appToken: 'xapp-test' },
    telegram: { botToken: 'test-token-123' },
    imessage: { gatewayUrl: 'https://imsgw.example.com', phoneNumber: '+15551234567', token: 'imsg-token' },
  } as const

  async function startSession(
    provider: keyof typeof TEST_CONFIGS,
    messageOpts: { chatId: string; userName?: string; chatName?: string },
  ) {
    const integrationId = createChatIntegration({
      agentSlug: 'test-agent',
      provider,
      config: TEST_CONFIGS[provider],
      name: 'Test Bot',
    })
    // These tests exercise session-spawn context, not access control — disable
    // the owner-approval gate telegram integrations get by default.
    testSqlite.prepare('UPDATE chat_integrations SET require_approval = 0 WHERE id = ?').run(integrationId)
    await chatIntegrationManager.addIntegration(integrationId)

    mockConnector.simulateIncomingMessage('Hello agent!', messageOpts.chatId, 'user-1', {
      userName: messageOpts.userName,
      chatName: messageOpts.chatName,
    })
    await waitForCondition(() => createSessionSpy.mock.calls.length > 0)
    return createSessionSpy.mock.calls[0][0] as Record<string, unknown>
  }

  it('passes a DM-flavored system prompt for slack direct messages', async () => {
    const args = await startSession('slack', { chatId: 'D0AAA111', userName: 'Iddo Gino' })
    expect(args.systemPrompt).toContain('a direct message conversation with Iddo Gino')
    expect(args.systemPrompt).toContain('delivered automatically')
  })

  it('passes a channel-flavored system prompt for slack channel messages', async () => {
    const args = await startSession('slack', { chatId: 'C0BBB222', userName: 'Iddo Gino', chatName: '#office' })
    expect(args.systemPrompt).toContain('the channel #office')
  })

  it('passes the iMessage system prompt for imessage sessions', async () => {
    const args = await startSession('imessage', { chatId: '+15559876543', userName: 'Iddo Gino' })
    expect(args.systemPrompt).toContain('iMessage-based conversation')
  })

  it('does not attach a system prompt for telegram sessions', async () => {
    const args = await startSession('telegram', { chatId: 'chat-1', userName: 'Iddo Gino' })
    expect('systemPrompt' in args).toBe(false)
  })
})

/**
 * Chat integration model/effort resolution tests.
 *
 * Preference order when a chat message spawns a new agent session:
 * integration override > agent default (agent preferences) > global default.
 * Reuses the e2e harness wiring (MockChatClientConnector →
 * ChatIntegrationManager → MockContainerClient); createSession options are
 * captured via an instance spy because the mock client normalizes the model
 * before recording it in its static call log.
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

// The manager loads this via a dynamic import at session-spawn time; vi.mock
// intercepts that path too.
const mockReadAgentPreferences = vi.fn()
vi.mock('@shared/lib/services/agent-preferences-service', () => ({
  readAgentPreferences: (...args: unknown[]) => mockReadAgentPreferences(...args),
}))

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

// ── Tests ──────────────────────────────────────────────────────────────

describe('chat integration model and effort resolution', () => {
  let createSessionSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-model-res-test-'))
    process.env.SUPERAGENT_DATA_DIR = testDir

    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })

    mockConnector = new MockChatClientConnector()

    mockContainerClient = new MockContainerClient({ agentId: 'test-agent' })
    await mockContainerClient.start()
    MockContainerClient.resetCallRecords()
    // Capture the raw options the manager passes, before the mock client
    // resolves the model alias for its static call records.
    createSessionSpy = vi.spyOn(mockContainerClient, 'createSession') as ReturnType<typeof vi.spyOn>;

    (containerManager.ensureRunning as ReturnType<typeof vi.fn>).mockResolvedValue(mockContainerClient)

    mockReadAgentPreferences.mockReset()
    mockReadAgentPreferences.mockResolvedValue({})
  })

  afterEach(async () => {
    chatIntegrationManager.stop()
    // Let pending async handlers drain before closing the DB
    await new Promise(r => setTimeout(r, 50))
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  // Preference order: integration override > agent default > global default.
  async function startSession(integrationOverrides: Record<string, unknown> = {}) {
    const integrationId = createChatIntegration({
      agentSlug: 'test-agent',
      provider: 'telegram',
      config: { botToken: 'test-token-123' },
      name: 'Test Bot',
      ...integrationOverrides,
    })
    // These tests exercise session-spawn defaults, not access control, so
    // disable the owner-approval gate telegram integrations get by default.
    testSqlite.prepare('UPDATE chat_integrations SET require_approval = 0 WHERE id = ?').run(integrationId)
    await chatIntegrationManager.addIntegration(integrationId)

    mockConnector.simulateIncomingMessage('Hello agent!', 'chat-1', 'user-1')
    await waitForCondition(() => createSessionSpy.mock.calls.length > 0)
    return createSessionSpy.mock.calls[0][0] as Record<string, unknown>
  }

  it('uses the global default when neither integration nor agent set one', async () => {
    const args = await startSession()
    expect(args.model).toBe('claude-sonnet-4-20250514')
    // Effort must be omitted entirely, not sent as undefined.
    expect('effort' in args).toBe(false)
  })

  it('falls back to the agent default over the global default', async () => {
    mockReadAgentPreferences.mockResolvedValue({ defaultModel: 'opus', defaultEffort: 'high' })
    const args = await startSession()
    expect(mockReadAgentPreferences).toHaveBeenCalledWith('test-agent')
    expect(args.model).toBe('opus')
    expect(args.effort).toBe('high')
  })

  it('prefers the integration override over the agent default', async () => {
    mockReadAgentPreferences.mockResolvedValue({ defaultModel: 'opus', defaultEffort: 'high' })
    const args = await startSession({ model: 'claude-haiku-4-5-20251001', effort: 'low' })
    expect(args.model).toBe('claude-haiku-4-5-20251001')
    expect(args.effort).toBe('low')
  })
})

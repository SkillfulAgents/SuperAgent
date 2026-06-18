import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as path from 'path'
import crypto from 'node:crypto'
import * as schema from '../db/schema'

// ---------------------------------------------------------------------------
// Task 5 — inbound access gate on handleIncomingMessageInner.
//
// The gate hits the REAL access service, which reads/writes the REAL db. We
// wire one in-memory better-sqlite3 behind @shared/lib/db (db + sqlite over a
// single connection, exactly like chat-integration-access-service.test.ts) so
// the gate decisions exercise genuine SQL — bootstrap, pending insert, caps.
//
// The container/agent spend path is stubbed: ensureRunning is the spend spy and
// is made to reject so the handler bails right after the spy records the call —
// we only need to know whether spend was REACHED, never to run it.
// ---------------------------------------------------------------------------

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() {
    return testDb
  },
  get sqlite() {
    return testSqlite
  },
}))

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: { ensureRunning: vi.fn() },
}))

vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: vi.fn(),
}))

import { chatIntegrationManager } from './chat-integration-manager'
import { containerManager } from '@shared/lib/container/container-manager'
import { agentExists } from '@shared/lib/services/agent-service'
import {
  getChatAccess,
  approveChatAccess,
  denyChatAccess,
  revokeChatAccess,
} from '@shared/lib/services/chat-integration-access-service'
import type { IncomingMessage } from './base-connector'

const INT = 'int-tg'

interface ManagerInternals {
  connections: Map<string, unknown>
  messageQueues: Map<string, unknown>
  chatSessions: Map<string, unknown>
  handleIncomingMessageInner: (
    integrationId: string,
    message: IncomingMessage,
    integration: unknown,
  ) => Promise<void>
}

const mgr = chatIntegrationManager as unknown as ManagerInternals

const integration = {
  id: INT,
  agentSlug: 'test-agent',
  provider: 'telegram',
  name: 'Test Bot',
  model: null,
  effort: null,
  sessionTimeout: 24,
  createdByUserId: null,
}

let sendMessage: ReturnType<typeof vi.fn>

function seedIntegration(requireApproval = true): void {
  const now = Date.now()
  testSqlite
    .prepare(
      `INSERT INTO chat_integrations (id, agent_slug, provider, config, require_approval, created_at, updated_at)
       VALUES (?, 'test-agent', 'telegram', '{}', ?, ?, ?)`,
    )
    .run(INT, requireApproval ? 1 : 0, now, now)
}

function insertAccess(chatId: string, status: 'pending' | 'allowed' | 'denied'): string {
  const id = crypto.randomUUID()
  const now = Date.now()
  testSqlite
    .prepare(
      `INSERT INTO chat_integration_access
         (id, integration_id, external_chat_id, chat_type, status, requested_at, created_at, updated_at)
       VALUES (?, ?, ?, 'private', ?, ?, ?, ?)`,
    )
    .run(id, INT, chatId, status, now, now, now)
  return id
}

function msg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    externalMessageId: 'm1',
    text: 'hello',
    chatId: 'c1',
    userId: 'u1',
    chatType: 'private',
    userName: 'Alice',
    chatName: 'Alice',
    timestamp: new Date(),
    ...overrides,
  }
}

function injectConn(): void {
  sendMessage = vi.fn().mockResolvedValue('sent-id')
  mgr.connections.set(INT, {
    connector: {
      sendMessage,
      showTypingIndicator: vi.fn().mockResolvedValue(undefined),
    },
    integration,
    messageUnsubscribe: null,
    interactiveUnsubscribe: null,
    errorUnsubscribe: null,
    typingHintUnsubscribe: null,
  })
}

function deliver(message: IncomingMessage): Promise<void> {
  return mgr.handleIncomingMessageInner(INT, message, integration)
}

describe('chat-integration inbound access gate', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    seedIntegration(true)

    // The spend-stop stub rejects ensureRunning, which the handler logs via
    // console.error before bailing — expected, so silence it.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.mocked(agentExists).mockReset().mockResolvedValue(true)
    // Stop the handler the moment spend is reached: the spy records the call,
    // the catch swallows the rejection and returns.
    vi.mocked(containerManager.ensureRunning).mockReset().mockRejectedValue(new Error('stop-after-spend'))

    mgr.connections.clear()
    mgr.messageQueues.clear()
    mgr.chatSessions.clear()
    injectConn()
  })

  afterEach(() => {
    testSqlite?.close()
    mgr.connections.clear()
    mgr.messageQueues.clear()
    mgr.chatSessions.clear()
    vi.restoreAllMocks()
  })

  it('allowed chat → reaches the spend path (container start)', async () => {
    const id = insertAccess('c1', 'pending')
    approveChatAccess(id, 'owner')

    await deliver(msg({ chatId: 'c1' }))

    expect(containerManager.ensureRunning).toHaveBeenCalledTimes(1)
  })

  it('private first contact → bootstraps to allowed and forwards', async () => {
    await deliver(msg({ chatId: 'c1', chatType: 'private' }))

    const row = getChatAccess(INT, 'c1')
    expect(row?.status).toBe('allowed')
    expect(row?.approvalSource).toBe('auto_first_contact')
    expect(containerManager.ensureRunning).toHaveBeenCalledTimes(1)
  })

  it('group first contact → blocked, pending row, exactly one notice', async () => {
    // A first private contact would bootstrap; bootstrap an unrelated private
    // chat so the group is a genuine second contact and stays pending.
    await deliver(msg({ chatId: 'owner-dm', chatType: 'private' }))
    sendMessage.mockClear()
    vi.mocked(containerManager.ensureRunning).mockClear()

    await deliver(msg({ chatId: 'g1', chatType: 'group', text: 'hi from group' }))

    const row = getChatAccess(INT, 'g1')
    expect(row?.status).toBe('pending')
    expect(row?.requestNoticeSentAt).not.toBeNull()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('g1', {
      text: 'This bot needs the owner to approve this chat before it can respond.',
    })
    expect(containerManager.ensureRunning).not.toHaveBeenCalled()
  })

  it('pending repeat → no second notice', async () => {
    await deliver(msg({ chatId: 'owner-dm', chatType: 'private' }))
    await deliver(msg({ chatId: 'g1', chatType: 'group', text: 'first' }))
    sendMessage.mockClear()

    await deliver(msg({ chatId: 'g1', chatType: 'group', text: 'second' }))

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('denied chat → silent drop, no notice, no spend', async () => {
    const id = insertAccess('c9', 'pending')
    denyChatAccess(id, 'owner')

    await deliver(msg({ chatId: 'c9' }))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(containerManager.ensureRunning).not.toHaveBeenCalled()
  })

  it('/start from a new private chat → bootstraps, greets once, agent not invoked', async () => {
    await deliver(msg({ chatId: 'c1', chatType: 'private', text: '/start' }))

    expect(getChatAccess(INT, 'c1')?.status).toBe('allowed')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('c1', {
      text: "You're connected. Send a message to start.",
    })
    expect(agentExists).not.toHaveBeenCalled()
    expect(containerManager.ensureRunning).not.toHaveBeenCalled()
  })

  it('revoke between two sends → second is dropped at the gate before spend', async () => {
    const id = insertAccess('c1', 'pending')
    approveChatAccess(id, 'owner')

    await deliver(msg({ chatId: 'c1', text: 'first' }))
    expect(containerManager.ensureRunning).toHaveBeenCalledTimes(1)

    revokeChatAccess(id, 'owner')

    await deliver(msg({ chatId: 'c1', text: 'second' }))
    expect(containerManager.ensureRunning).toHaveBeenCalledTimes(1)
  })

  it('revoke mid-flight (after the gate, before container start) → spend re-check drops it', async () => {
    const id = insertAccess('c1', 'pending')
    approveChatAccess(id, 'owner')

    // Revoke lands during the agentExists await — after the gate has passed but
    // before the container starts. The re-check guarding ensureRunning must catch it.
    vi.mocked(agentExists).mockImplementationOnce(async () => {
      revokeChatAccess(id, 'owner')
      return true
    })

    await deliver(msg({ chatId: 'c1', text: 'mid-flight' }))

    expect(agentExists).toHaveBeenCalledTimes(1)
    expect(containerManager.ensureRunning).not.toHaveBeenCalled()
  })
})

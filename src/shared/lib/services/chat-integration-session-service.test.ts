import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() { return testDb },
  get sqlite() { return testSqlite },
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

import {
  createChatIntegrationSession,
  getChatIntegrationSession,
  getChatIntegrationSessionById,
  touchChatIntegrationSession,
  archiveChatIntegrationSession,
} from './chat-integration-session-service'
import { createChatIntegration } from './chat-integration-service'

describe('chat-integration-session-service', () => {
  let integrationId: string

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-session-test-'))
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })

    integrationId = createChatIntegration({
      agentSlug: 'test-agent',
      provider: 'telegram',
      config: { botToken: 'test-token' },
    })
  })

  afterEach(async () => {
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  describe('touchChatIntegrationSession', () => {
    it('updates the updatedAt timestamp', async () => {
      const sessionId = createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'session-1',
        displayName: 'Test Chat',
      })

      const before = getChatIntegrationSessionById(sessionId)
      expect(before).not.toBeNull()
      const beforeTime = before!.updatedAt.getTime()

      // Small delay to ensure timestamp differs
      await new Promise(r => setTimeout(r, 20))

      touchChatIntegrationSession(sessionId)

      const after = getChatIntegrationSessionById(sessionId)
      expect(after!.updatedAt.getTime()).toBeGreaterThan(beforeTime)
    })

    it('returns true when session exists', () => {
      const sessionId = createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-2',
        sessionId: 'session-2',
      })
      expect(touchChatIntegrationSession(sessionId)).toBe(true)
    })

    it('returns false for non-existent session', () => {
      expect(touchChatIntegrationSession('nonexistent')).toBe(false)
    })
  })

  describe('session rotation scenario', () => {
    it('archived session is not returned by getChatIntegrationSession', () => {
      const sessionId = createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-rotate',
        sessionId: 'old-session',
        displayName: 'Old',
      })

      // Session is active
      expect(getChatIntegrationSession(integrationId, 'chat-rotate')).not.toBeNull()

      // Archive it (simulates timeout rotation)
      archiveChatIntegrationSession(sessionId)

      // Should no longer be found as active
      expect(getChatIntegrationSession(integrationId, 'chat-rotate')).toBeNull()

      // Create a new session for the same chat
      createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-rotate',
        sessionId: 'new-session',
        displayName: 'New',
      })

      // New session is returned
      const newSession = getChatIntegrationSession(integrationId, 'chat-rotate')
      expect(newSession).not.toBeNull()
      expect(newSession!.sessionId).toBe('new-session')
    })
  })
})

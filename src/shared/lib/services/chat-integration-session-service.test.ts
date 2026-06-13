import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
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
  resolveActiveSession,
  getLastDisplayName,
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

  describe('resolveActiveSession', () => {
    it('returns active session when no timeout configured', () => {
      createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'session-1',
        displayName: 'Alice',
      })

      const result = resolveActiveSession(integrationId, 'chat-1', null)
      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe('session-1')
    })

    it('returns null when no session exists', () => {
      const result = resolveActiveSession(integrationId, 'nonexistent', null)
      expect(result).toBeNull()
    })

    it('returns session when within timeout window', () => {
      createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'session-1',
      })

      // Session was just created — 1 hour timeout should not trigger
      const result = resolveActiveSession(integrationId, 'chat-1', 1)
      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe('session-1')
    })

    it('archives and returns null when session exceeds timeout', () => {
      const sessionId = createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'session-1',
      })

      // Backdate the session's updatedAt to 3 hours ago
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
      testDb.update(schema.chatIntegrationSessions)
        .set({ updatedAt: threeHoursAgo })
        .where(eq(schema.chatIntegrationSessions.id, sessionId))
        .run()

      const result = resolveActiveSession(integrationId, 'chat-1', 1)
      expect(result).toBeNull()

      // Verify the old session was archived
      const archived = getChatIntegrationSessionById(sessionId)
      expect(archived!.archivedAt).not.toBeNull()
    })

    it('calls onArchive callback when rotating', () => {
      const sessionId = createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'session-1',
      })

      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
      testDb.update(schema.chatIntegrationSessions)
        .set({ updatedAt: threeHoursAgo })
        .where(eq(schema.chatIntegrationSessions.id, sessionId))
        .run()

      const onArchive = vi.fn()
      resolveActiveSession(integrationId, 'chat-1', 1, onArchive)

      expect(onArchive).toHaveBeenCalledWith(sessionId)
    })

    it('does not call onArchive when session is valid', () => {
      createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'session-1',
      })

      const onArchive = vi.fn()
      resolveActiveSession(integrationId, 'chat-1', 1, onArchive)

      expect(onArchive).not.toHaveBeenCalled()
    })
  })

  describe('resolveActiveSession with duplicate active sessions', () => {
    it('finds the current session even when an older orphaned session exists', () => {
      // Simulate the bug: earlier code created a session but never archived it.
      // Then the manager created a new session for the same chat.
      // Now there are TWO non-archived sessions for the same (integrationId, chatId).
      const orphanId = createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'orphan-session',
        displayName: 'Alice',
      })

      // Backdate the orphan to 3 hours ago
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
      testDb.update(schema.chatIntegrationSessions)
        .set({ updatedAt: threeHoursAgo })
        .where(eq(schema.chatIntegrationSessions.id, orphanId))
        .run()

      // Create the "real" current session (as the manager would)
      createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'current-session',
        displayName: 'Alice',
      })

      // With a 1-hour timeout, resolveActiveSession should find 'current-session',
      // NOT archive the orphan and return null.
      const result = resolveActiveSession(integrationId, 'chat-1', 1)
      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe('current-session')
    })

    it('returns the most recent session when no timeout is configured', () => {
      // Two non-archived sessions, no timeout
      const oldId = createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'old-session',
      })

      // Backdate the old session so updatedAt differs
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      testDb.update(schema.chatIntegrationSessions)
        .set({ updatedAt: oneHourAgo })
        .where(eq(schema.chatIntegrationSessions.id, oldId))
        .run()

      createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'new-session',
      })

      const result = resolveActiveSession(integrationId, 'chat-1', null)
      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe('new-session')
    })
  })

  describe('getChatIntegrationSession ordering', () => {
    it('returns the most recently updated session when duplicates exist', () => {
      const oldId = createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'old-session',
      })

      // Backdate the old session
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      testDb.update(schema.chatIntegrationSessions)
        .set({ updatedAt: twoHoursAgo })
        .where(eq(schema.chatIntegrationSessions.id, oldId))
        .run()

      createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'new-session',
      })

      // Should return the newer one, not the older insertion-order one
      const result = getChatIntegrationSession(integrationId, 'chat-1')
      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe('new-session')
    })

    it('ignores archived sessions', () => {
      const archivedId = createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'archived-session',
      })
      archiveChatIntegrationSession(archivedId)

      createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'active-session',
      })

      const result = getChatIntegrationSession(integrationId, 'chat-1')
      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe('active-session')
    })
  })

  describe('getLastDisplayName', () => {
    it('returns undefined when no sessions exist', () => {
      expect(getLastDisplayName(integrationId, 'chat-1')).toBeUndefined()
    })

    it('returns display name from the most recent session', () => {
      const id1 = createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'session-1',
        displayName: 'Old Name',
      })

      // Backdate first session
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      testDb.update(schema.chatIntegrationSessions)
        .set({ updatedAt: oneHourAgo })
        .where(eq(schema.chatIntegrationSessions.id, id1))
        .run()

      createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'session-2',
        displayName: 'Current Name',
      })

      expect(getLastDisplayName(integrationId, 'chat-1')).toBe('Current Name')
    })

    it('skips sessions without display names', () => {
      createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'session-1',
        // no displayName
      })

      createChatIntegrationSession({
        integrationId,
        externalChatId: 'chat-1',
        sessionId: 'session-2',
        displayName: 'Named Session',
      })

      expect(getLastDisplayName(integrationId, 'chat-1')).toBe('Named Session')
    })

    it('does not return display names from other chats', () => {
      createChatIntegrationSession({
        integrationId,
        externalChatId: 'other-chat',
        sessionId: 'session-1',
        displayName: 'Other Chat Name',
      })

      expect(getLastDisplayName(integrationId, 'chat-1')).toBeUndefined()
    })
  })
})

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
  isSessionTimedOut,
  rotateChatIntegrationSession,
  markConversationConsolidated,
  listConsolidationCandidates,
  getLatestTimeoutRecap,
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

    it('archives the timed-out session, tags the rotation, and returns null', () => {
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

      // The old session is archived AND tagged as a timeout rotation (rotatedAt
      // set), so the consolidation sweep can tell it apart from a /clear.
      const archived = getChatIntegrationSessionById(sessionId)
      expect(archived!.archivedAt).not.toBeNull()
      expect(archived!.rotatedAt).not.toBeNull()
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

  describe('isSessionTimedOut (exported)', () => {
    it('is false when no timeout is configured', () => {
      const old = { updatedAt: new Date(Date.now() - 10 * 60 * 60 * 1000), createdAt: new Date() }
      expect(isSessionTimedOut(old, null)).toBe(false)
      expect(isSessionTimedOut(old, 0)).toBe(false)
      expect(isSessionTimedOut(old, undefined)).toBe(false)
    })

    it('is true past the threshold and false within it', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
      expect(isSessionTimedOut({ updatedAt: threeHoursAgo, createdAt: threeHoursAgo }, 1)).toBe(true)
      const recent = { updatedAt: new Date(Date.now() - 10 * 60 * 1000), createdAt: new Date() }
      expect(isSessionTimedOut(recent, 1)).toBe(false)
    })
  })

  describe('rotateChatIntegrationSession', () => {
    it('sets archivedAt AND rotatedAt', () => {
      const id = createChatIntegrationSession({ integrationId, externalChatId: 'c', sessionId: 's' })
      expect(rotateChatIntegrationSession(id)).toBe(true)
      const row = getChatIntegrationSessionById(id)!
      expect(row.archivedAt).not.toBeNull()
      expect(row.rotatedAt).not.toBeNull()
    })

    it('returns false for a missing row', () => {
      expect(rotateChatIntegrationSession('nope')).toBe(false)
    })
  })

  describe('archiveChatIntegrationSession does not tag a rotation', () => {
    it('leaves rotatedAt null (so /clear, self-heal and revoke are excluded)', () => {
      const id = createChatIntegrationSession({ integrationId, externalChatId: 'c', sessionId: 's' })
      archiveChatIntegrationSession(id)
      const row = getChatIntegrationSessionById(id)!
      expect(row.archivedAt).not.toBeNull()
      expect(row.rotatedAt).toBeNull()
    })
  })

  describe('markConversationConsolidated', () => {
    it('sets recap + consolidatedAt and is an atomic no-op the second time', () => {
      const id = createChatIntegrationSession({ integrationId, externalChatId: 'c', sessionId: 's' })
      expect(markConversationConsolidated(id, 'recap one')).toBe(true)
      const first = getChatIntegrationSessionById(id)!
      expect(first.recap).toBe('recap one')
      expect(first.consolidatedAt).not.toBeNull()

      // The WHERE consolidated_at IS NULL guard makes a re-commit a no-op.
      expect(markConversationConsolidated(id, 'recap two')).toBe(false)
      const second = getChatIntegrationSessionById(id)!
      expect(second.recap).toBe('recap one')
    })

    it('does not touch archivedAt or rotatedAt', () => {
      const id = createChatIntegrationSession({ integrationId, externalChatId: 'c', sessionId: 's' })
      markConversationConsolidated(id, 'recap')
      const row = getChatIntegrationSessionById(id)!
      expect(row.archivedAt).toBeNull()
      expect(row.rotatedAt).toBeNull()
    })
  })

  describe('listConsolidationCandidates', () => {
    it('returns only rows with consolidatedAt null for the integration', () => {
      const a = createChatIntegrationSession({ integrationId, externalChatId: 'c1', sessionId: 's1' })
      const b = createChatIntegrationSession({ integrationId, externalChatId: 'c2', sessionId: 's2' })
      markConversationConsolidated(b, 'done')

      const ids = listConsolidationCandidates(integrationId).map((r) => r.id)
      expect(ids).toContain(a)
      expect(ids).not.toContain(b)
    })
  })

  describe('getLatestTimeoutRecap', () => {
    it('returns null when there is no archived row', () => {
      createChatIntegrationSession({ integrationId, externalChatId: 'c', sessionId: 's' })
      expect(getLatestTimeoutRecap(integrationId, 'c')).toBeNull()
    })

    it('returns the recap of the most-recent timeout-rotated row', () => {
      const id = createChatIntegrationSession({ integrationId, externalChatId: 'c', sessionId: 's' })
      rotateChatIntegrationSession(id)
      markConversationConsolidated(id, 'banked recap')
      expect(getLatestTimeoutRecap(integrationId, 'c')).toBe('banked recap')
    })

    it('returns null when the rotated row is not yet consolidated (recap still null)', () => {
      const id = createChatIntegrationSession({ integrationId, externalChatId: 'c', sessionId: 's' })
      rotateChatIntegrationSession(id)
      expect(getLatestTimeoutRecap(integrationId, 'c')).toBeNull()
    })

    it('returns null when the most-recent archive is a /clear, without falling back to an older rotated recap', () => {
      // Older conversation: timeout-rotated and consolidated, so it carries a recap.
      const older = createChatIntegrationSession({ integrationId, externalChatId: 'c', sessionId: 's-old' })
      rotateChatIntegrationSession(older)
      markConversationConsolidated(older, 'stale recap from two conversations ago')
      testDb.update(schema.chatIntegrationSessions)
        .set({ archivedAt: new Date(Date.now() - 60 * 60 * 1000) })
        .where(eq(schema.chatIntegrationSessions.id, older))
        .run()

      // Newer conversation: a /clear archive — rotatedAt stays null.
      const newer = createChatIntegrationSession({ integrationId, externalChatId: 'c', sessionId: 's-new' })
      archiveChatIntegrationSession(newer)

      // Most-recent archive is the /clear, so no seed and no fallback to the older recap.
      expect(getLatestTimeoutRecap(integrationId, 'c')).toBeNull()
    })

    it('ignores rotated recaps from other chats', () => {
      const other = createChatIntegrationSession({ integrationId, externalChatId: 'other', sessionId: 's' })
      rotateChatIntegrationSession(other)
      markConversationConsolidated(other, 'other chat recap')
      expect(getLatestTimeoutRecap(integrationId, 'c')).toBeNull()
    })
  })

})

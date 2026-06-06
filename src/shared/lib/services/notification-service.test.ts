import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

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

import {
  createNotification,
  getUnreadCount,
  getSessionIdsWithUnreadNotifications,
  getUnreadNotificationsByAgents,
  deleteNotificationsBySessionIds,
  listNotifications,
  USER_ACTIONABLE_NOTIFICATION_TYPES,
  type NotificationType,
} from './notification-service'

const ALL_TYPES: NotificationType[] = [
  'session_complete',
  'session_waiting',
  'session_scheduled',
  'session_webhook',
  'session_chat_integration',
]

async function seedOneOfEachType(agentSlug: string, sessionId: string) {
  for (const type of ALL_TYPES) {
    await createNotification({
      type,
      sessionId: `${sessionId}-${type}`,
      agentSlug,
      title: `${type} title`,
      body: `${type} body`,
    })
  }
}

describe('notification-service', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })
  })

  afterEach(() => {
    testSqlite?.close()
  })

  describe('USER_ACTIONABLE_NOTIFICATION_TYPES', () => {
    it('contains exactly the two types that drive UI badges', () => {
      expect([...USER_ACTIONABLE_NOTIFICATION_TYPES].sort()).toEqual([
        'session_complete',
        'session_waiting',
      ])
    })

    it('does not contain lifecycle types', () => {
      const arr = [...USER_ACTIONABLE_NOTIFICATION_TYPES] as string[]
      expect(arr).not.toContain('session_scheduled')
      expect(arr).not.toContain('session_webhook')
      expect(arr).not.toContain('session_chat_integration')
    })
  })

  describe('getUnreadCount', () => {
    it('counts only user-actionable types — lifecycle events do not contribute', async () => {
      await seedOneOfEachType('agent-a', 'sess')
      // 5 unread notifications inserted, but only 2 are user-actionable.
      expect(await getUnreadCount()).toBe(2)
    })

    it('returns 0 when only lifecycle events are unread', async () => {
      for (const type of ['session_scheduled', 'session_webhook', 'session_chat_integration'] as const) {
        await createNotification({
          type,
          sessionId: 'sess',
          agentSlug: 'agent-a',
          title: 't',
          body: 'b',
        })
      }
      expect(await getUnreadCount()).toBe(0)
    })

    it('counts both session_complete and session_waiting', async () => {
      await createNotification({ type: 'session_complete', sessionId: 's1', agentSlug: 'a', title: 't', body: 'b' })
      await createNotification({ type: 'session_waiting', sessionId: 's2', agentSlug: 'a', title: 't', body: 'b' })
      expect(await getUnreadCount()).toBe(2)
    })
  })

  describe('getSessionIdsWithUnreadNotifications', () => {
    it('only returns session IDs whose unread notifications are user-actionable', async () => {
      await seedOneOfEachType('agent-a', 'sess')
      const sessionIds = await getSessionIdsWithUnreadNotifications('agent-a')
      // Of the 5 we inserted, only the two actionable ones contribute.
      expect(sessionIds.size).toBe(2)
      expect(sessionIds.has('sess-session_complete')).toBe(true)
      expect(sessionIds.has('sess-session_waiting')).toBe(true)
      expect(sessionIds.has('sess-session_scheduled')).toBe(false)
      expect(sessionIds.has('sess-session_webhook')).toBe(false)
      expect(sessionIds.has('sess-session_chat_integration')).toBe(false)
    })

    it('returns empty set when all unread notifications are lifecycle events', async () => {
      await createNotification({ type: 'session_scheduled', sessionId: 's1', agentSlug: 'a', title: 't', body: 'b' })
      await createNotification({ type: 'session_webhook', sessionId: 's2', agentSlug: 'a', title: 't', body: 'b' })
      const ids = await getSessionIdsWithUnreadNotifications('a')
      expect(ids.size).toBe(0)
    })
  })

  describe('getUnreadNotificationsByAgents', () => {
    it('only returns user-actionable unreads, grouped by agent', async () => {
      await seedOneOfEachType('agent-a', 'sess-a')
      await seedOneOfEachType('agent-b', 'sess-b')
      const map = await getUnreadNotificationsByAgents(['agent-a', 'agent-b'])
      // Each agent contributes exactly the two actionable session ids.
      expect(map.get('agent-a')?.size).toBe(2)
      expect(map.get('agent-b')?.size).toBe(2)
      expect(map.get('agent-a')?.has('sess-a-session_complete')).toBe(true)
      expect(map.get('agent-a')?.has('sess-a-session_scheduled')).toBe(false)
    })

    it('omits agents whose only unreads are lifecycle events', async () => {
      // agent-a has actionable unreads, agent-b only lifecycle.
      await createNotification({ type: 'session_complete', sessionId: 's1', agentSlug: 'agent-a', title: 't', body: 'b' })
      await createNotification({ type: 'session_scheduled', sessionId: 's2', agentSlug: 'agent-b', title: 't', body: 'b' })
      await createNotification({ type: 'session_webhook', sessionId: 's3', agentSlug: 'agent-b', title: 't', body: 'b' })
      const map = await getUnreadNotificationsByAgents(['agent-a', 'agent-b'])
      expect(map.has('agent-a')).toBe(true)
      expect(map.has('agent-b')).toBe(false)
    })
  })

  // SUP-228: retention cleanup must remove notification rows for deleted sessions.
  describe('deleteNotificationsBySessionIds', () => {
    it('removes rows for the given session ids and leaves others intact', async () => {
      await createNotification({ type: 'session_complete', sessionId: 's1', agentSlug: 'a', title: 't', body: 'b' })
      await createNotification({ type: 'session_waiting', sessionId: 's2', agentSlug: 'a', title: 't', body: 'b' })
      await createNotification({ type: 'session_complete', sessionId: 's3', agentSlug: 'a', title: 't', body: 'b' })

      // s3 simulates a session whose filesystem delete failed — it must survive.
      const deleted = await deleteNotificationsBySessionIds(['s1', 's2'])
      expect(deleted).toBe(2)

      const remaining = await listNotifications(50)
      const sessionIds = remaining.map((n) => n.sessionId)
      expect(sessionIds).toEqual(['s3'])
    })

    it('removes every notification type for a session (not just actionable ones)', async () => {
      await seedOneOfEachType('a', 'sess')
      // sessionIds are `sess-<type>`; delete two of them.
      const deleted = await deleteNotificationsBySessionIds([
        'sess-session_complete',
        'sess-session_webhook',
      ])
      expect(deleted).toBe(2)
      const remaining = await listNotifications(50)
      expect(remaining.map((n) => n.sessionId).sort()).toEqual([
        'sess-session_chat_integration',
        'sess-session_scheduled',
        'sess-session_waiting',
      ])
    })

    it('is a no-op on an empty list (returns 0, deletes nothing)', async () => {
      await createNotification({ type: 'session_complete', sessionId: 's1', agentSlug: 'a', title: 't', body: 'b' })
      const deleted = await deleteNotificationsBySessionIds([])
      expect(deleted).toBe(0)
      expect((await listNotifications(50)).length).toBe(1)
    })
  })
})

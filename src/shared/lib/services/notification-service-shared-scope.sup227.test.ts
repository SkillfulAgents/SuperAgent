/**
 * SUP-227 — Notifications are AGENT/SESSION-scoped with SHARED read state.
 *
 * Product decision (closes SUP-227 / PR #238 as wontfix): notifications are not
 * per-user mail. Every type is a session-lifecycle fact (session_complete,
 * session_waiting, ...) on a shared agent, and its body is a strict subset of
 * session content that any ACL member can already see. So read state is
 * deliberately SHARED: one teammate acknowledging an item clears it for the
 * team. There is no per-user owner column (the speculative, never-wired
 * `notifications.user_id` was dropped in migration 0022).
 *
 * These tests lock in the two invariants that must survive that decision:
 *   1. Cross-agent isolation (a user only sees / can mark notifications for
 *      agents they hold an ACL entry on) — enforced purely by the service-layer
 *      getAccessibleAgentSlugs() filter, independent of any owner column. This
 *      is also what keeps the middleware-less `POST /read-by-session/:sessionId`
 *      route safe: an inaccessible session is a silent no-op, not a 403 that
 *      would leak existence.
 *   2. Shared read state across co-members of the same agent (a glance by one
 *      member clears the shared row for the others). If someone ever re-adds a
 *      per-user owner to "fix" this, these assertions flip and force the
 *      conversation back to SUP-227.
 *
 * Dedicated file (self-documenting; reuses the same in-memory sqlite + drizzle
 * harness as notification-service.test.ts, which also exercises migration 0022).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
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
  listNotifications,
  getUnreadCount,
  markSessionNotificationsRead,
  markAllAsRead,
} from './notification-service'
import { notifications, agentAcl } from '../db/schema'

const USER_A = 'user-a'
const USER_B = 'user-b'
const AGENT_SHARED = 'shared-agent'
const AGENT_PRIVATE = 'private-agent' // only USER_A has access
const SESSION_SHARED = 'session-shared'
const SESSION_PRIVATE = 'session-private'

async function seedAcl() {
  await testDb.insert(agentAcl).values([
    { id: 'acl-a-shared', userId: USER_A, agentSlug: AGENT_SHARED, role: 'owner', createdAt: new Date() },
    { id: 'acl-b-shared', userId: USER_B, agentSlug: AGENT_SHARED, role: 'user', createdAt: new Date() },
    { id: 'acl-a-private', userId: USER_A, agentSlug: AGENT_PRIVATE, role: 'owner', createdAt: new Date() },
  ])
}

describe('SUP-227: notifications are agent-scoped with shared read state', () => {
  beforeEach(async () => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    // Running the full migration chain here also asserts that 0022 (the
    // user_id table-rebuild drop) applies cleanly.
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    await seedAcl()
  })

  afterEach(() => {
    testSqlite?.close()
  })

  describe('cross-agent isolation (independent of any owner column)', () => {
    beforeEach(async () => {
      await createNotification({
        type: 'session_waiting',
        sessionId: SESSION_SHARED,
        agentSlug: AGENT_SHARED,
        title: 'shared',
        body: 'shared body',
      })
      await createNotification({
        type: 'session_waiting',
        sessionId: SESSION_PRIVATE,
        agentSlug: AGENT_PRIVATE,
        title: 'private',
        body: 'private body',
      })
    })

    it('a user only lists notifications for agents they can access', async () => {
      // USER_B has no ACL on AGENT_PRIVATE → must not see it.
      expect((await listNotifications(50, USER_B)).map((n) => n.agentSlug)).toEqual([AGENT_SHARED])
      // USER_A is on both agents → sees both.
      expect((await listNotifications(50, USER_A)).map((n) => n.agentSlug).sort()).toEqual(
        [AGENT_PRIVATE, AGENT_SHARED]
      )
    })

    it('a user cannot mark-read a session belonging to an agent they cannot access (silent no-op)', async () => {
      // This is what keeps the middleware-less read-by-session route safe.
      const marked = await markSessionNotificationsRead(SESSION_PRIVATE, USER_B)
      expect(marked).toBe(0)

      const privateRow = await testDb
        .select()
        .from(notifications)
        .where(eq(notifications.sessionId, SESSION_PRIVATE))
      expect(privateRow[0]?.isRead).toBe(false)
    })

    it('markAllAsRead only clears the caller’s accessible agents', async () => {
      await markAllAsRead(USER_B)
      const privateRow = await testDb
        .select()
        .from(notifications)
        .where(eq(notifications.sessionId, SESSION_PRIVATE))
      // USER_B cleared nothing on AGENT_PRIVATE.
      expect(privateRow[0]?.isRead).toBe(false)
    })
  })

  describe('shared read state across co-members of the same agent', () => {
    beforeEach(async () => {
      await createNotification({
        type: 'session_waiting',
        sessionId: SESSION_SHARED,
        agentSlug: AGENT_SHARED,
        title: 'shared',
        body: 'shared body',
      })
    })

    it('both co-members see the same single shared row (no per-user fan-out)', async () => {
      expect((await listNotifications(50, USER_A)).map((n) => n.sessionId)).toEqual([SESSION_SHARED])
      expect((await listNotifications(50, USER_B)).map((n) => n.sessionId)).toEqual([SESSION_SHARED])
      // Exactly one physical row backs both views.
      const rows = await testDb.select().from(notifications)
      expect(rows).toHaveLength(1)
    })

    it('one member acknowledging clears the shared item for the other (the intended behavior)', async () => {
      expect(await getUnreadCount(USER_A)).toBe(1)
      expect(await getUnreadCount(USER_B)).toBe(1)

      // USER_B opens the session → marks the shared row read.
      const marked = await markSessionNotificationsRead(SESSION_SHARED, USER_B)
      expect(marked).toBe(1)

      // The acknowledgment is shared: USER_A's unread count drops too. If this
      // ever reads 1 again, someone re-introduced per-user read state — see the
      // SUP-227 decision before "fixing" it.
      expect(await getUnreadCount(USER_B)).toBe(0)
      expect(await getUnreadCount(USER_A)).toBe(0)
    })
  })
})

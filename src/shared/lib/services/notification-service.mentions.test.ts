/**
 * session_mention rows are recipient-scoped. Agent-scoped rows stay shared.
 * Harness matches notification-service-shared-scope.sup227.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
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
  createNotification, listNotifications, getUnreadCount, getUnreadMentionCount,
  getSessionIdsWithUnreadNotifications, getOldestUnreadMentionBySession, markSessionNotificationsRead,
  markAsRead, getUnreadNotificationsByAgents, getSessionIdsWithUnreadMentionsByAgents, markAllAsRead,
} from './notification-service'
import { agentAcl } from '../db/schema'

async function seedAcl() {
  await testDb.insert(agentAcl).values([
    { id: 'acl-a-billing', userId: 'a', agentSlug: 'billing', role: 'owner', createdAt: new Date() },
    { id: 'acl-b-billing', userId: 'b', agentSlug: 'billing', role: 'user', createdAt: new Date() },
  ])
}

describe('session_mention recipient scoping', () => {
  beforeEach(async () => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    await seedAcl()
  })

  afterEach(() => {
    testSqlite?.close()
  })

  it('a mention row is visible only to its recipient', async () => {
    await createNotification({ type: 'session_mention', sessionId: 's1', agentSlug: 'billing', title: 'G mentioned you', body: 'x', recipientUserId: 'b', messageUuid: 'm1' })
    expect((await listNotifications(50, 'a')).map((n) => n.id)).toHaveLength(0)
    expect((await listNotifications(50, 'b')).map((n) => n.id)).toHaveLength(1)
    expect(await getUnreadCount('a')).toBe(0)
    expect(await getUnreadCount('b')).toBe(1)
    expect(await getUnreadMentionCount('a')).toBe(0)
    expect(await getUnreadMentionCount('b')).toBe(1)
  })

  it('agent-scoped rows stay visible to everyone', async () => {
    await createNotification({ type: 'session_complete', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x' })
    expect(await getUnreadCount('a')).toBe(1)
    expect(await getUnreadCount('b')).toBe(1)
  })

  it('agent-scoped unread ids stay visible when the caller has no ACL row', async () => {
    await createNotification({ type: 'session_complete', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x' })
    expect(await getSessionIdsWithUnreadNotifications('billing', 'admin-no-acl')).toEqual(new Set(['s1']))
  })

  it('unread session ids and oldest mention are per recipient', async () => {
    await createNotification({ type: 'session_mention', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x', recipientUserId: 'b', messageUuid: 'm-old' })
    await createNotification({ type: 'session_mention', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x', recipientUserId: 'b', messageUuid: 'm-new' })
    expect(await getSessionIdsWithUnreadNotifications('billing', 'a')).toEqual(new Set())
    expect(await getSessionIdsWithUnreadNotifications('billing', 'b')).toEqual(new Set(['s1']))
    expect(await getOldestUnreadMentionBySession('billing', 'b')).toEqual(new Map([['s1', 'm-old']]))
  })

  it('read-by-session clears only my mention rows', async () => {
    await createNotification({ type: 'session_mention', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x', recipientUserId: 'b', messageUuid: 'm1' })
    await createNotification({ type: 'session_mention', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x', recipientUserId: 'a', messageUuid: 'm1' })
    expect(await markSessionNotificationsRead('s1', 'b')).toBe(1)
    expect(await getUnreadCount('a')).toBe(1)
  })

  it('duplicate (messageUuid, recipient) insert is rejected by the unique index', async () => {
    await createNotification({ type: 'session_mention', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x', recipientUserId: 'b', messageUuid: 'm1' })
    await expect(createNotification({ type: 'session_mention', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x', recipientUserId: 'b', messageUuid: 'm1' })).rejects.toThrow()
  })

  it('user a calling markAsRead on b\'s mention row returns false and leaves it unread', async () => {
    const id = await createNotification({ type: 'session_mention', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x', recipientUserId: 'b', messageUuid: 'm1' })
    expect(await markAsRead(id, 'a')).toBe(false)
    expect(await getUnreadCount('b')).toBe(1)
  })

  it('getUnreadNotificationsByAgents keeps a mention row out of the other user\'s set', async () => {
    await createNotification({ type: 'session_mention', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x', recipientUserId: 'b', messageUuid: 'm1' })
    await createNotification({ type: 'session_complete', sessionId: 's2', agentSlug: 'billing', title: 't', body: 'x' })
    expect(await getUnreadNotificationsByAgents(['billing'], 'a')).toEqual(new Map([['billing', new Set(['s2'])]]))
    expect(await getUnreadNotificationsByAgents(['billing'], 'b')).toEqual(new Map([['billing', new Set(['s1', 's2'])]]))
  })

  it('getSessionIdsWithUnreadMentionsByAgents is per recipient', async () => {
    await createNotification({ type: 'session_mention', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x', recipientUserId: 'b', messageUuid: 'm1' })
    expect(await getSessionIdsWithUnreadMentionsByAgents(['billing'], 'b')).toEqual(new Map([['billing', new Set(['s1'])]]))
    expect(await getSessionIdsWithUnreadMentionsByAgents(['billing'], 'a')).toEqual(new Map())
  })

  it('markAllAsRead clears only the caller\'s mention rows', async () => {
    await createNotification({ type: 'session_mention', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x', recipientUserId: 'b', messageUuid: 'm1' })
    await createNotification({ type: 'session_mention', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x', recipientUserId: 'a', messageUuid: 'm2' })
    expect(await markAllAsRead('b')).toBe(1)
    expect(await getUnreadCount('a')).toBe(1)
    expect(await getUnreadCount('b')).toBe(0)
  })

  it('repeated agent-scoped rows (NULL messageUuid) do not trip the unique index', async () => {
    await createNotification({ type: 'session_complete', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x' })
    await expect(createNotification({ type: 'session_complete', sessionId: 's1', agentSlug: 'billing', title: 't', body: 'x' })).resolves.toBeTruthy()
  })
})

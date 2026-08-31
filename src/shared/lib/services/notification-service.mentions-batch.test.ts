/**
 * Coverage-auditor additions (pr-ready-loop, SUP-703): the agents-list badge
 * path reads getUnreadNotificationsByAgents + getSessionIdsWithUnreadMentionsByAgents,
 * and /notifications/read-all goes through markAllAsRead. The sibling
 * notification-service.mentions.test.ts covers the single-agent reads; this
 * pins the batch variants and mark-all to the same recipient scoping, plus the
 * unique index's NULL behavior for agent-scoped rows.
 * Harness matches notification-service.mentions.test.ts.
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
  createNotification, getUnreadNotificationsByAgents, getSessionIdsWithUnreadMentionsByAgents,
  markAllAsRead, getUnreadCount,
} from './notification-service'
import { agentAcl } from '../db/schema'

async function seedAcl() {
  await testDb.insert(agentAcl).values([
    { id: 'acl-a-billing', userId: 'a', agentSlug: 'billing', role: 'owner', createdAt: new Date() },
    { id: 'acl-b-billing', userId: 'b', agentSlug: 'billing', role: 'user', createdAt: new Date() },
  ])
}

describe('session_mention batch reads + mark-all scoping', () => {
  beforeEach(async () => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    await seedAcl()
  })

  afterEach(() => {
    testSqlite?.close()
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

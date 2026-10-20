/**
 * Mentions are the one targeted notification: a row per person tagged, seen
 * and read by that person alone. Shared rows keep their shared read state
 * (notification-service-shared-scope.sup227.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('@shared/lib/db', () => ({
  get db() {
    return testDb
  },
}))

import {
  createNotification,
  listNotifications,
  countNotifications,
  getUnreadCount,
  getSessionIdsWithUnreadNotifications,
  getUnreadNotificationsByAgents,
  getSessionIdsWithUnreadMentions,
  getUnreadMentionsByAgents,
  getUnreadMentionCount,
  markSessionNotificationsRead,
  markAllAsRead,
  deleteMessageNotifications,
} from './notification-service'
import { notifications, agentAcl } from '../db/schema'

const MIKE = 'user-mike'
const SARA = 'user-sara'
const AGENT = 'shared-agent'
const SESSION = 'session-1'

async function mention(recipientUserId: string, messageUuid = `msg-${recipientUserId}`) {
  return createNotification({
    type: 'session_mention',
    sessionId: SESSION,
    agentSlug: AGENT,
    title: 'Dana mentioned you',
    body: '@Mike look at this',
    recipientUserId,
    messageUuid,
  })
}

describe('targeted mention notifications', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
    await testDb.insert(agentAcl).values([
      { id: 'acl-mike', userId: MIKE, agentSlug: AGENT, role: 'user', createdAt: new Date() },
      { id: 'acl-sara', userId: SARA, agentSlug: AGENT, role: 'user', createdAt: new Date() },
    ])
  })

  afterEach(async () => {
    await handle.close()
  })

  it('is listed and counted for its recipient only', async () => {
    await mention(MIKE)

    expect((await listNotifications(50, MIKE)).map((n) => n.type)).toEqual(['session_mention'])
    expect(await listNotifications(50, SARA)).toEqual([])
    expect(await countNotifications(MIKE)).toBe(1)
    expect(await countNotifications(SARA)).toBe(0)
    expect(await getUnreadCount(MIKE)).toBe(1)
    expect(await getUnreadCount(SARA)).toBe(0)
  })

  it("dots the session for its recipient only, and still shows everyone's shared rows", async () => {
    await mention(MIKE)
    expect(await getSessionIdsWithUnreadNotifications(AGENT, undefined, MIKE)).toEqual(new Set([SESSION]))
    expect(await getSessionIdsWithUnreadNotifications(AGENT, undefined, SARA)).toEqual(new Set())
    expect((await getUnreadNotificationsByAgents([AGENT], MIKE)).get(AGENT)).toEqual(new Set([SESSION]))
    expect((await getUnreadNotificationsByAgents([AGENT], SARA)).get(AGENT)).toBeUndefined()

    await createNotification({ type: 'session_waiting', sessionId: 'session-2', agentSlug: AGENT, title: 'Waiting', body: '' })
    expect(await getSessionIdsWithUnreadNotifications(AGENT, undefined, SARA)).toEqual(new Set(['session-2']))
  })

  it("opening the session clears a viewer's own mention, never someone else's", async () => {
    await mention(MIKE)
    await mention(SARA)

    expect(await markSessionNotificationsRead(SESSION, SARA)).toBe(1)
    expect(await getUnreadCount(SARA)).toBe(0)
    expect(await getUnreadCount(MIKE)).toBe(1)

    await markAllAsRead(SARA)
    const [mikeRow] = await testDb.select().from(notifications).where(eq(notifications.recipientUserId, MIKE))
    expect(mikeRow.isRead).toBe(false)
  })

  it("finds a viewer's unread mentions for the @ marker, and drops them once read", async () => {
    await mention(MIKE)
    await createNotification({ type: 'session_complete', sessionId: 'session-2', agentSlug: AGENT, title: 'Done', body: '' })

    expect(await getSessionIdsWithUnreadMentions(AGENT, MIKE)).toEqual(new Set([SESSION]))
    expect(await getSessionIdsWithUnreadMentions(AGENT, SARA)).toEqual(new Set())
    expect((await getUnreadMentionsByAgents([AGENT, 'other'], MIKE)).get(AGENT)).toEqual(new Set([SESSION]))
    expect(await getUnreadMentionCount(MIKE)).toBe(1)
    expect(await getUnreadMentionCount(SARA)).toBe(0)

    await markSessionNotificationsRead(SESSION, MIKE)
    expect(await getSessionIdsWithUnreadMentions(AGENT, MIKE)).toEqual(new Set())
    expect(await getUnreadMentionCount(MIKE)).toBe(0)
  })

  it('holds one row per person per message', async () => {
    await mention(MIKE, 'msg-1')
    await expect(mention(MIKE, 'msg-1')).rejects.toThrow()
    await mention(SARA, 'msg-1')
    expect(await testDb.select().from(notifications)).toHaveLength(2)
  })

  it("withdraws a message's mentions and leaves every other row", async () => {
    await mention(MIKE, 'msg-1')
    await mention(SARA, 'msg-1')
    await mention(MIKE, 'msg-2')

    const withdrawn = await deleteMessageNotifications('msg-1')
    expect(withdrawn).toEqual(expect.arrayContaining([
      { recipientUserId: MIKE, agentSlug: AGENT, sessionId: SESSION },
      { recipientUserId: SARA, agentSlug: AGENT, sessionId: SESSION },
    ]))
    expect(withdrawn).toHaveLength(2)
    expect((await testDb.select().from(notifications)).map((n) => n.messageUuid)).toEqual(['msg-2'])
    expect(await deleteMessageNotifications('msg-1')).toEqual([])
  })
})

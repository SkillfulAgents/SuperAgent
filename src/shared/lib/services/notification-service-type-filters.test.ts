/**
 * The Notifications page's type filters: list, count and read-all narrowed to
 * some types, and the per-type totals behind the tab counts. Visibility rules
 * (agent access, other people's mentions) still apply under a filter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  getNotificationCounts,
  markAllAsRead,
  markAsRead,
  type NotificationType,
} from './notification-service'
import { agentAcl, user } from '../db/schema'

const MIKE = 'user-mike'
const SARA = 'user-sara'
const AGENT = 'shared-agent'
const OTHER_AGENT = 'mikes-only-agent'

async function notify(type: NotificationType, overrides: { agentSlug?: string; recipientUserId?: string; id?: string } = {}) {
  return createNotification({
    type,
    sessionId: `session-${type}-${overrides.id ?? '1'}`,
    agentSlug: overrides.agentSlug ?? AGENT,
    title: `${type} title`,
    body: `${type} body`,
    ...(overrides.recipientUserId
      ? { recipientUserId: overrides.recipientUserId, messageUuid: `msg-${overrides.recipientUserId}-${overrides.id ?? '1'}` }
      : {}),
  })
}

describe('notification type filters', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
    await testDb.insert(user).values([MIKE, SARA].map(id => ({ id, name: id, email: `${id}@example.com` })))
    await testDb.insert(agentAcl).values([
      { id: 'acl-mike', userId: MIKE, agentSlug: AGENT, role: 'user', createdAt: new Date() },
      { id: 'acl-sara', userId: SARA, agentSlug: AGENT, role: 'user', createdAt: new Date() },
      { id: 'acl-mike-2', userId: MIKE, agentSlug: OTHER_AGENT, role: 'user', createdAt: new Date() },
    ])
  })

  afterEach(async () => {
    await handle.close()
  })

  it('lists and counts only the requested types', async () => {
    await notify('session_waiting')
    await notify('session_complete')
    await notify('session_scheduled')
    await notify('session_webhook')

    const automations: NotificationType[] = ['session_scheduled', 'session_webhook', 'session_chat_integration']
    expect((await listNotifications(50, undefined, 0, automations)).map(n => n.type).sort())
      .toEqual(['session_scheduled', 'session_webhook'])
    expect(await countNotifications(undefined, automations)).toBe(2)
    expect(await countNotifications(undefined, ['session_waiting'])).toBe(1)
  })

  it('treats no types (or an empty list) as no filter', async () => {
    await notify('session_waiting')
    await notify('session_complete')
    expect(await listNotifications(50)).toHaveLength(2)
    expect(await listNotifications(50, undefined, 0, [])).toHaveLength(2)
    expect(await countNotifications(undefined, [])).toBe(2)
  })

  it('keeps agent access and mention visibility under a filter', async () => {
    await notify('session_complete', { agentSlug: OTHER_AGENT })
    await notify('session_complete')
    await notify('session_mention', { recipientUserId: MIKE })

    expect(await countNotifications(SARA, ['session_complete'])).toBe(1)
    expect(await countNotifications(MIKE, ['session_complete'])).toBe(2)
    expect(await listNotifications(50, SARA, 0, ['session_mention'])).toEqual([])
    expect(await countNotifications(MIKE, ['session_mention'])).toBe(1)
  })

  it('pages within a filter', async () => {
    for (const id of ['a', 'b', 'c']) await notify('session_waiting', { id })
    await notify('session_complete')
    const firstPage = await listNotifications(2, undefined, 0, ['session_waiting'])
    const secondPage = await listNotifications(2, undefined, 2, ['session_waiting'])
    expect(firstPage).toHaveLength(2)
    expect(secondPage).toHaveLength(1)
    expect(new Set([...firstPage, ...secondPage].map(n => n.id)).size).toBe(3)
  })

  describe('getNotificationCounts', () => {
    it.each([[undefined, 5, 0], [MIKE, 4, 1], [SARA, 3, 1]] as const)('preserves badge and mention semantics for viewer %s', async (viewer, count, mentions) => {
      await notify('session_complete')
      await notify('session_complete', { agentSlug: OTHER_AGENT })
      await notify('session_scheduled')
      await notify('session_webhook')
      await notify('session_chat_integration')
      await notify('session_mention', { recipientUserId: MIKE })
      await notify('session_mention', { recipientUserId: SARA })
      // Untargeted legacy rows appear in history, but do not tag a recipient.
      await notify('session_mention')
      await markAsRead(await notify('session_waiting'))

      const counts = await getNotificationCounts(viewer)
      expect(counts.count).toBe(count)
      expect(counts.mentions).toBe(mentions)
      expect(counts.types.session_scheduled).toEqual({ total: 1, unread: 1 })
      expect(counts.types.session_waiting).toEqual({ total: 1, unread: 0 })
    })

    it('returns every type, zero-filled, with totals and unread', async () => {
      const read = await notify('session_waiting', { id: 'a' })
      await notify('session_waiting', { id: 'b' })
      await notify('session_scheduled')
      await markAsRead(read)

      const { types: counts } = await getNotificationCounts()
      expect(counts.session_waiting).toEqual({ total: 2, unread: 1 })
      // Non-actionable types still count unread: the tab shows them unread.
      expect(counts.session_scheduled).toEqual({ total: 1, unread: 1 })
      expect(counts.session_complete).toEqual({ total: 0, unread: 0 })
      expect(Object.keys(counts).sort()).toEqual([
        'session_chat_integration',
        'session_complete',
        'session_mention',
        'session_scheduled',
        'session_waiting',
        'session_webhook',
      ])
    })

    it('counts only what the viewer can see', async () => {
      await notify('session_complete', { agentSlug: OTHER_AGENT })
      await notify('session_mention', { recipientUserId: MIKE })
      const { types: sara } = await getNotificationCounts(SARA)
      expect(sara.session_complete.total).toBe(0)
      expect(sara.session_mention.total).toBe(0)
      const { types: mike } = await getNotificationCounts(MIKE)
      expect(mike.session_complete.total).toBe(1)
      expect(mike.session_mention).toEqual({ total: 1, unread: 1 })
    })
  })

  describe('markAllAsRead with types', () => {
    it('reads only the requested types', async () => {
      await notify('session_waiting')
      await notify('session_complete')
      await notify('session_scheduled')

      expect(await markAllAsRead(undefined, ['session_complete'])).toBe(1)
      const { types: counts } = await getNotificationCounts()
      expect(counts.session_complete.unread).toBe(0)
      expect(counts.session_waiting.unread).toBe(1)
      expect(counts.session_scheduled.unread).toBe(1)
    })

    it('stays within the viewer’s rows', async () => {
      await notify('session_complete', { agentSlug: OTHER_AGENT })
      await notify('session_complete')
      expect(await markAllAsRead(SARA, ['session_complete'])).toBe(1)
      expect((await getNotificationCounts(MIKE)).types.session_complete.unread).toBe(1)
    })

    it('reads everything without types', async () => {
      await notify('session_waiting')
      await notify('session_scheduled')
      expect(await markAllAsRead()).toBe(2)
    })
  })
})

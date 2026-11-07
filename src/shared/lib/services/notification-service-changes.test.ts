import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import { notifications, user } from '../db/schema'
import { globalFeed, agentFeedChannel, userFeedChannel } from '../notifications/global-feed'
import { backgroundSettled } from '../background'

let handle: TestDatabase
vi.mock('../db', () => ({ get db() { return handle.db } }))
vi.mock('../auth/mode', () => ({ isAuthMode: () => true }))

import { createNotification, deleteNotification, deleteNotificationsBySessionIds, deleteOldNotifications, markAllAsRead, markAsRead, markSessionNotificationsRead } from './notification-service'

describe('notification mutation feed', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    await handle.db.insert(user).values({ id: 'recipient', name: 'Recipient', email: 'recipient@example.com' })
  })
  afterEach(async () => { await handle.close() })

  it.each(['single read', 'session read', 'filtered read-all', 'single delete', 'session cleanup', 'age cleanup'] as const)('%s announces committed changes to the shared audience and mention recipient only', async operation => {
    const shared = await createNotification({ type: 'session_complete', agentSlug: 'a', sessionId: 's', title: 'Done', body: '' })
    const mention = await createNotification({ type: 'session_mention', agentSlug: 'a', sessionId: 's', title: 'Mention', body: '', recipientUserId: 'recipient' })
    const received = vi.fn()
    const unrelated = vi.fn()
    const subscription = await globalFeed.subscribe([agentFeedChannel('a'), userFeedChannel('recipient')], received)
    const other = await globalFeed.subscribe([agentFeedChannel('other'), userFeedChannel('other')], unrelated)
    const sourceClientId = crypto.randomUUID()
    try {
      if (operation === 'single read') {
        await markAsRead(shared, sourceClientId)
        await markAsRead(mention, sourceClientId)
      } else if (operation === 'session read') await markSessionNotificationsRead('s', undefined, sourceClientId)
      else if (operation === 'filtered read-all') await markAllAsRead(undefined, ['session_complete', 'session_mention'], sourceClientId)
      else if (operation === 'single delete') {
        await deleteNotification(shared)
        await deleteNotification(mention)
      } else if (operation === 'session cleanup') await deleteNotificationsBySessionIds(['s'])
      else {
        await handle.db.update(notifications).set({ createdAt: new Date(0) })
        await deleteOldNotifications()
      }
      await backgroundSettled()
      expect(received).toHaveBeenCalledTimes(2)
      const source = operation.includes('read') ? { sourceClientId } : {}
      expect(received).toHaveBeenCalledWith({ type: 'notifications_changed', agentSlug: 'a', ...source })
      expect(received).toHaveBeenCalledWith({ type: 'notifications_changed', agentSlug: 'a', recipientUserId: 'recipient', ...source })
      expect(unrelated).not.toHaveBeenCalled()
      const rows = await handle.db.select().from(notifications).where(eq(notifications.agentSlug, 'a'))
      if (operation.includes('read')) expect(rows.every(row => row.isRead)).toBe(true)
      else expect(rows).toHaveLength(0)
    } finally {
      await subscription.unsubscribe()
      await other.unsubscribe()
    }
  })

  it('coalesces a bulk write per audience and emits nothing for an empty write', async () => {
    for (let i = 0; i < 3; i++) await createNotification({ type: 'session_complete', agentSlug: 'a', sessionId: `s${i}`, title: 'Done', body: '' })
    const received = vi.fn()
    const subscription = await globalFeed.subscribe([agentFeedChannel('a')], received)
    try {
      expect(await markAllAsRead()).toBe(3)
      expect(await markAllAsRead()).toBe(0)
      expect(await deleteNotificationsBySessionIds([])).toBe(0)
      expect(await deleteNotification('missing')).toBe(false)
      await backgroundSettled()
      expect(received).toHaveBeenCalledTimes(1)
    } finally { await subscription.unsubscribe() }
  })
})

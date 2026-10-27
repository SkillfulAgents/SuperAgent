/**
 * Notifications API Routes
 *
 * Endpoints for managing user notifications.
 * In auth mode, queries are scoped to the user's accessible agents.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  listNotifications,
  countNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  markSessionNotificationsRead,
  deleteNotification,
  getUnreadMentionCount,
} from '@shared/lib/services/notification-service'
import type { GlobalFeedEvent } from '@shared/lib/notifications/global-feed'
import { background } from '@shared/lib/background'
import { isAuthMode } from '@shared/lib/auth/mode'
import { Authenticated, HasNotificationAccess } from '../middleware/auth'
import { waitForClientGone } from '../lib/wait-for-client-gone'
import { openNotificationsFeed } from '../lib/notifications-feed'

const notificationsRouter = new Hono()

notificationsRouter.use('*', Authenticated())

/**
 * Get the userId to scope notification queries.
 * Returns undefined for non-auth mode (see all).
 * Returns the user's ID for auth mode users (including admins — admins
 * only see notifications for agents explicitly shared with them, matching
 * the agent-listing behavior).
 */
function getScopedUserId(c: { get: (key: never) => unknown }): string | undefined {
  if (!isAuthMode()) return undefined
  const user = c.get('user' as never) as { id: string; role?: string } | undefined
  if (!user) return undefined
  return user.id
}

// GET /api/notifications/stream - SSE stream for global notifications (used by Electron main process)
notificationsRouter.get('/stream', async (c) => {
  const clientSignal = c.req.raw.signal
  const user = isAuthMode()
    ? (c.get('user' as never) as { id: string; role?: string } | undefined)
    : undefined

  return streamSSE(c, async (stream) => {
    // The client left during the middleware: nothing to set up for it.
    if (clientSignal.aborted) return
    const clientGone = waitForClientGone(clientSignal, stream)
    let pingInterval: ReturnType<typeof setInterval> | null = null
    let close: (() => void) | null = null

    const write = (event: GlobalFeedEvent): void => {
      background(stream.writeSSE({ data: JSON.stringify(event), event: 'message' }).catch((error) => {
        console.error('Error sending global notification SSE:', error)
      }), { name: 'notifications-route.write-event' })
    }

    try {
      close = openNotificationsFeed({ user, deliver: write, onLoadError: () => stream.abort() })

      // Send initial connection message
      await stream.writeSSE({
        data: JSON.stringify({ type: 'connected' }),
        event: 'message',
      })

      // Keep-alive ping every 30 seconds
      pingInterval = setInterval(() => background(async () => {
        try {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'ping' }),
            event: 'message',
          })
        } catch {
          if (pingInterval) clearInterval(pingInterval)
        }
      }, { name: 'notifications-route.write-ping' }), 30000)

      await clientGone
    } finally {
      if (pingInterval) clearInterval(pingInterval)
      close?.()
    }
  })
})

// GET /api/notifications - List recent notifications
notificationsRouter.get('/', async (c) => {
  try {
    const limitParam = c.req.query('limit')
    const offsetParam = c.req.query('offset')
    const limit = limitParam ? parseInt(limitParam, 10) : 50
    const offset = offsetParam ? parseInt(offsetParam, 10) : 0
    const userId = getScopedUserId(c)

    const [items, total] = await Promise.all([
      listNotifications(limit, userId, offset),
      countNotifications(userId),
    ])
    return c.json({ items, total })
  } catch (error) {
    console.error('Failed to fetch notifications:', error)
    return c.json({ error: 'Failed to fetch notifications' }, 500)
  }
})

// GET /api/notifications/unread-count - Get unread notification count
notificationsRouter.get('/unread-count', async (c) => {
  try {
    const userId = getScopedUserId(c)
    const [count, mentions] = await Promise.all([
      getUnreadCount(userId),
      // Mentions exist in auth mode only, for a signed-in recipient.
      userId ? getUnreadMentionCount(userId) : 0,
    ])
    return c.json({ count, mentions })
  } catch (error) {
    console.error('Failed to fetch unread count:', error)
    return c.json({ error: 'Failed to fetch unread count' }, 500)
  }
})

// POST /api/notifications/:id/read - Mark a notification as read
notificationsRouter.post('/:id/read', HasNotificationAccess(), async (c) => {
  try {
    const notificationId = c.req.param('id')
    const success = await markAsRead(notificationId)

    if (!success) {
      return c.json({ error: 'Notification not found' }, 404)
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to mark notification as read:', error)
    return c.json({ error: 'Failed to mark notification as read' }, 500)
  }
})

// POST /api/notifications/read-all - Mark all notifications as read
notificationsRouter.post('/read-all', async (c) => {
  try {
    const userId = getScopedUserId(c)
    const count = await markAllAsRead(userId)
    return c.json({ success: true, count })
  } catch (error) {
    console.error('Failed to mark all notifications as read:', error)
    return c.json({ error: 'Failed to mark all notifications as read' }, 500)
  }
})

// POST /api/notifications/read-by-session/:sessionId - Mark session notifications as read
notificationsRouter.post('/read-by-session/:sessionId', async (c) => {
  try {
    const sessionId = c.req.param('sessionId')
    const userId = getScopedUserId(c)
    const count = await markSessionNotificationsRead(sessionId, userId)
    return c.json({ success: true, count })
  } catch (error) {
    console.error('Failed to mark session notifications as read:', error)
    return c.json({ error: 'Failed to mark session notifications as read' }, 500)
  }
})

// DELETE /api/notifications/:id - Delete a notification
notificationsRouter.delete('/:id', HasNotificationAccess(), async (c) => {
  try {
    const notificationId = c.req.param('id')
    const success = await deleteNotification(notificationId)

    if (!success) {
      return c.json({ error: 'Notification not found' }, 404)
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete notification:', error)
    return c.json({ error: 'Failed to delete notification' }, 500)
  }
})

export default notificationsRouter

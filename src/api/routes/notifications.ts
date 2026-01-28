/**
 * Notifications API Routes
 *
 * Endpoints for managing user notifications.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  listNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  markSessionNotificationsRead,
  deleteNotification,
} from '@shared/lib/services/notification-service'
import { messagePersister } from '@shared/lib/container/message-persister'

const notificationsRouter = new Hono()

// GET /api/notifications/stream - SSE stream for global notifications (used by Electron main process)
notificationsRouter.get('/stream', async (c) => {
  return streamSSE(c, async (stream) => {
    let pingInterval: ReturnType<typeof setInterval> | null = null
    let unsubscribe: (() => void) | null = null

    try {
      // Subscribe to global notifications
      unsubscribe = messagePersister.addGlobalNotificationClient(async (data) => {
        try {
          await stream.writeSSE({
            data: JSON.stringify(data),
            event: 'message',
          })
        } catch (error) {
          console.error('Error sending global notification SSE:', error)
        }
      })

      // Send initial connection message
      await stream.writeSSE({
        data: JSON.stringify({ type: 'connected' }),
        event: 'message',
      })

      // Keep-alive ping every 30 seconds
      pingInterval = setInterval(async () => {
        try {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'ping' }),
            event: 'message',
          })
        } catch {
          if (pingInterval) clearInterval(pingInterval)
        }
      }, 30000)

      // Keep connection open
      await new Promise(() => {})
    } finally {
      if (pingInterval) clearInterval(pingInterval)
      if (unsubscribe) unsubscribe()
    }
  })
})

// GET /api/notifications - List recent notifications
notificationsRouter.get('/', async (c) => {
  try {
    const limitParam = c.req.query('limit')
    const limit = limitParam ? parseInt(limitParam, 10) : 50

    const notificationList = await listNotifications(limit)
    return c.json(notificationList)
  } catch (error) {
    console.error('Failed to fetch notifications:', error)
    return c.json({ error: 'Failed to fetch notifications' }, 500)
  }
})

// GET /api/notifications/unread-count - Get unread notification count
notificationsRouter.get('/unread-count', async (c) => {
  try {
    const count = await getUnreadCount()
    return c.json({ count })
  } catch (error) {
    console.error('Failed to fetch unread count:', error)
    return c.json({ error: 'Failed to fetch unread count' }, 500)
  }
})

// POST /api/notifications/:id/read - Mark a notification as read
notificationsRouter.post('/:id/read', async (c) => {
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
    const count = await markAllAsRead()
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
    const count = await markSessionNotificationsRead(sessionId)
    return c.json({ success: true, count })
  } catch (error) {
    console.error('Failed to mark session notifications as read:', error)
    return c.json({ error: 'Failed to mark session notifications as read' }, 500)
  }
})

// DELETE /api/notifications/:id - Delete a notification
notificationsRouter.delete('/:id', async (c) => {
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

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
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  markSessionNotificationsRead,
  deleteNotification,
  getAccessibleAgentSlugs,
} from '@shared/lib/services/notification-service'
import { messagePersister } from '@shared/lib/container/message-persister'
import { isAuthMode } from '@shared/lib/auth/mode'
import { Authenticated, HasNotificationAccess } from '../middleware/auth'

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
  const user = isAuthMode()
    ? (c.get('user' as never) as { id: string; role?: string } | undefined)
    : undefined

  return streamSSE(c, async (stream) => {
    let pingInterval: ReturnType<typeof setInterval> | null = null
    let unsubscribe: (() => void) | null = null

    try {
      // Subscribe to global notifications
      unsubscribe = messagePersister.addGlobalNotificationClient(async (data) => {
        try {
          // In auth mode, filter events by agent access (admins included)
          if (isAuthMode() && user) {
            const agentSlug = (data as Record<string, unknown>)?.agentSlug as string | undefined
            if (agentSlug) {
              const accessible = await getAccessibleAgentSlugs(user.id)
              if (!accessible.includes(agentSlug)) return
            }
          }

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
    const userId = getScopedUserId(c)

    const notificationList = await listNotifications(limit, userId)
    return c.json(notificationList)
  } catch (error) {
    console.error('Failed to fetch notifications:', error)
    return c.json({ error: 'Failed to fetch notifications' }, 500)
  }
})

// GET /api/notifications/unread-count - Get unread notification count
notificationsRouter.get('/unread-count', async (c) => {
  try {
    const userId = getScopedUserId(c)
    const count = await getUnreadCount(userId)
    return c.json({ count })
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

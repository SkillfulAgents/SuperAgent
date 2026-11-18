import { NOTIFICATION_CLIENT_HEADER, notificationClientIdSchema } from '@shared/lib/notifications/notification-change-schema'
import { notificationReadAgentSlugs, confirmNotificationRead } from '@shared/lib/services/notification-read-state'
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
  getNotificationCounts,
  markAsRead,
  markAllAsRead,
  markSessionNotificationsRead,
  deleteNotification,
} from '@shared/lib/services/notification-service'
import { notificationTypesQuerySchema, readAllNotificationsBodySchema } from '@shared/lib/notifications/notification-filters'
import { isAuthMode } from '@shared/lib/auth/mode'
import { Authenticated, HasNotificationAccess } from '../middleware/auth'
import { waitForClientGone } from '../lib/wait-for-client-gone'
import { openNotificationsFeed } from '../lib/notifications-feed'
import { createSseFrameQueue } from '../lib/sse-frame-queue'

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

// GET /api/notifications/stream - SSE stream for global notifications (the
// renderer and the Electron main process). The feed reaches it through
// AppState, so an event published by another process arrives too.
notificationsRouter.get('/stream', async (c) => {
  const clientSignal = c.req.raw.signal
  const user = isAuthMode()
    ? (c.get('user' as never) as { id: string; role?: string } | undefined)
    : undefined

  return streamSSE(c, async (stream) => {
    // The client left during the middleware: nothing to set up for it.
    if (clientSignal.aborted) return
    // Ends the feed's subscriptions the moment the client is gone, also ones
    // still being set up then.
    const feed = new AbortController()
    const clientGone = waitForClientGone(clientSignal, stream).then(() => feed.abort())
    const frames = createSseFrameQueue({
      write: (data) => stream.writeSSE({ data, event: 'message' }),
      onOverflow: () => {
        // The client is not reading. Ending the stream bounds what waits for
        // it; the client reconnects and refetches.
        console.warn('[Notifications] A stream client fell too far behind; closing its stream')
        stream.abort()
      },
    })
    let pingInterval: ReturnType<typeof setInterval> | null = null

    try {
      // The greeting goes first, and nothing is written until the stream
      // follows every channel it carries (the tenant's, the user's and each
      // accessible agent's): the client refetches on it, so whatever changed
      // before it is in the refetch and whatever changes after it arrives
      // here.
      frames.push({ type: 'connected' })
      let loadFailed = false
      await openNotificationsFeed({
        user,
        deliver: (event) => frames.push(event),
        signal: feed.signal,
        onLoadError: () => {
          loadFailed = true
          stream.abort()
        },
      })
      // A first load that failed ended the stream: it never says connected.
      if (loadFailed) return
      frames.start()

      // Keep-alive every 30 seconds, when nothing else is being sent.
      pingInterval = setInterval(() => {
        if (frames.idle) frames.push({ type: 'ping' })
      }, 30000)

      await clientGone
    } catch (error) {
      // The feed could not be followed; the client reconnects.
      console.error('Failed to open the notifications stream:', error)
    } finally {
      if (pingInterval) clearInterval(pingInterval)
      feed.abort()
      frames.close()
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
    const parsedTypes = notificationTypesQuerySchema.safeParse(c.req.query('types'))
    if (!parsedTypes.success) return c.json({ error: 'Unknown notification type' }, 400)
    const types = parsedTypes.data
    const userId = getScopedUserId(c)

    const [items, total] = await Promise.all([
      listNotifications(limit, userId, offset, types),
      countNotifications(userId, types),
    ])
    return c.json({ items, total })
  } catch (error) {
    console.error('Failed to fetch notifications:', error)
    return c.json({ error: 'Failed to fetch notifications' }, 500)
  }
})

// GET /api/notifications/unread-count - Badge counts and per-type tab totals
notificationsRouter.get('/unread-count', async (c) => {
  try {
    return c.json(await getNotificationCounts(getScopedUserId(c)))
  } catch (error) {
    console.error('Failed to fetch unread count:', error)
    return c.json({ error: 'Failed to fetch unread count' }, 500)
  }
})

// POST /api/notifications/:id/read - Mark a notification as read
notificationsRouter.post('/:id/read', HasNotificationAccess(), async (c) => {
  try {
    const notificationId = c.req.param('id')
    const userId = getScopedUserId(c)
    const slugs = await notificationReadAgentSlugs({ kind: 'notification', id: notificationId }, userId)
    const success = await markAsRead(notificationId, notificationClientIdSchema.safeParse(c.req.header(NOTIFICATION_CLIENT_HEADER)).data)

    if (!success) {
      return c.json({ error: 'Notification not found' }, 404)
    }

    return c.json({ success: true, readState: await confirmNotificationRead(slugs, userId) })
  } catch (error) {
    console.error('Failed to mark notification as read:', error)
    return c.json({ error: 'Failed to mark notification as read' }, 500)
  }
})

// POST /api/notifications/read-all - Mark all notifications as read.
// An optional JSON body `{ types }` narrows it to a filtered tab's types.
notificationsRouter.post('/read-all', async (c) => {
  try {
    const raw = await c.req.text()
    let body: unknown = {}
    if (raw) {
      try { body = JSON.parse(raw) } catch { return c.json({ error: 'Invalid read-all body' }, 400) }
    }
    const parsedBody = readAllNotificationsBodySchema.safeParse(body)
    if (!parsedBody.success) return c.json({ error: 'Invalid read-all body' }, 400)
    const { types } = parsedBody.data
    const userId = getScopedUserId(c)
    const slugs = await notificationReadAgentSlugs({ kind: 'all', types }, userId)
    const count = await markAllAsRead(userId, types, notificationClientIdSchema.safeParse(c.req.header(NOTIFICATION_CLIENT_HEADER)).data)
    return c.json({ success: true, count, readState: await confirmNotificationRead(slugs, userId) })
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
    const slugs = await notificationReadAgentSlugs({ kind: 'session', sessionId }, userId)
    const count = await markSessionNotificationsRead(sessionId, userId, notificationClientIdSchema.safeParse(c.req.header(NOTIFICATION_CLIENT_HEADER)).data)
    return c.json({ success: true, count, readState: await confirmNotificationRead(slugs, userId) })
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

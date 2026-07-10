/**
 * Platform Notifications API Routes
 *
 * Proxy-live reads: thin forwards to the platform proxy's /v1/notifications
 * endpoints, identical in both auth modes (no local mirror). When the
 * platform isn't connected the list degrades to empty — the Notifications
 * page still renders local agent notifications.
 */

import { Hono } from 'hono'
import { getSettings } from '@shared/lib/config/settings'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import {
  listPlatformNotifications,
  markPlatformNotificationsRead,
} from '@shared/lib/services/platform-notifications-client'
import { Authenticated } from '../middleware/auth'

const platformNotificationsRouter = new Hono()

platformNotificationsRouter.use('*', Authenticated())

function isPlatformConnected(): boolean {
  return Boolean(getPlatformProxyBaseUrl() && getPlatformAccessToken())
}

// Org JWTs need an acting member appended to the bearer (in auth mode the
// request-scoped fetch interceptor re-attributes it to the acting user);
// opaque personal keys ignore the suffix.
function getMemberId(): string {
  return getSettings().platformAuth?.memberId ?? 'local'
}

const EMPTY_LIST = { notifications: [], total: 0, unread_count: 0, connected: false }

// The proxy rejects non-numeric/out-of-range values; drop them here so a bad
// param degrades to the default instead of an upstream 400.
function parseBoundedInt(value: string | undefined, min: number, max: number): number | undefined {
  if (!value) return undefined
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(Math.max(parsed, min), max)
}

// GET /api/platform-notifications?status=&limit=&offset= - live list from the platform
platformNotificationsRouter.get('/', async (c) => {
  if (!isPlatformConnected()) {
    return c.json(EMPTY_LIST)
  }
  try {
    const status = c.req.query('status') === 'unread' ? ('unread' as const) : undefined
    const list = await listPlatformNotifications(
      {
        status,
        limit: parseBoundedInt(c.req.query('limit'), 1, 100),
        offset: parseBoundedInt(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER),
      },
      getMemberId(),
    )
    return c.json({ ...list, connected: true })
  } catch (error) {
    // An unreachable proxy is the everyday offline case, not an app error:
    // degrade to the disconnected shape (a 200) so the renderer's polling
    // queries don't spin through retry cycles and Sentry captures forever.
    console.error('Failed to fetch platform notifications:', error)
    return c.json(EMPTY_LIST)
  }
})

// GET /api/platform-notifications/unread-count - unread count for the badge
platformNotificationsRouter.get('/unread-count', async (c) => {
  if (!isPlatformConnected()) {
    return c.json({ count: 0 })
  }
  try {
    const list = await listPlatformNotifications({ status: 'unread', limit: 1 }, getMemberId())
    return c.json({ count: list.unread_count })
  } catch (error) {
    // Same offline degradation as the list route: a zero badge, not a 502.
    console.error('Failed to fetch platform unread count:', error)
    return c.json({ count: 0 })
  }
})

// POST /api/platform-notifications/read { ids } - write-through mark-read
platformNotificationsRouter.post('/read', async (c) => {
  if (!isPlatformConnected()) {
    return c.json({ error: 'Platform not connected' }, 409)
  }
  try {
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    if (ids.length === 0) {
      return c.json({ error: 'Missing ids array' }, 400)
    }
    const updated = await markPlatformNotificationsRead(ids, getMemberId())
    return c.json({ success: true, updated })
  } catch (error) {
    console.error('Failed to mark platform notifications read:', error)
    return c.json({ error: 'Failed to mark platform notifications read' }, 502)
  }
})

// POST /api/platform-notifications/read-all - mark every unread row read
platformNotificationsRouter.post('/read-all', async (c) => {
  if (!isPlatformConnected()) {
    return c.json({ success: true, updated: 0 })
  }
  try {
    const memberId = getMemberId()
    // The platform has no bulk endpoint; resolve the unread page (100 covers
    // realistic announcement volume) and ack those ids.
    const unread = await listPlatformNotifications({ status: 'unread', limit: 100 }, memberId)
    const ids = unread.notifications.map((n) => n.id)
    const updated = ids.length > 0 ? await markPlatformNotificationsRead(ids, memberId) : 0
    return c.json({ success: true, updated })
  } catch (error) {
    console.error('Failed to mark all platform notifications read:', error)
    return c.json({ error: 'Failed to mark all platform notifications read' }, 502)
  }
})

export default platformNotificationsRouter

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'

/**
 * The Notifications page's type filters at the API boundary: `?types=` on the
 * list, the per-type counts, and read-all's optional `{ types }` body.
 */

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: Context, next: () => Promise<void>) => next(),
  HasNotificationAccess: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))

vi.mock('@shared/lib/services/notification-read-state', () => ({
  notificationReadAgentSlugs: vi.fn().mockResolvedValue([]),
  confirmNotificationRead: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/lib/services/notification-service', () => ({
  listNotifications: vi.fn().mockResolvedValue([]),
  countNotifications: vi.fn().mockResolvedValue(0),
  getNotificationCounts: vi.fn().mockResolvedValue({ count: 3, mentions: 1, types: {} }),
  markAsRead: vi.fn(),
  markAllAsRead: vi.fn().mockResolvedValue(0),
  markSessionNotificationsRead: vi.fn(),
  deleteNotification: vi.fn(),
  getAccessibleAgentSlugs: vi.fn().mockResolvedValue([]),
}))

import notificationsRouter from './notifications'
import { countNotifications, listNotifications, markAllAsRead } from '@shared/lib/services/notification-service'
import { notificationReadAgentSlugs } from '@shared/lib/services/notification-read-state'

describe('notification type filters (routes)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes ?types= to the list and its total', async () => {
    const res = await notificationsRouter.request('/?limit=15&offset=0&types=session_scheduled,session_webhook')
    expect(res.status).toBe(200)
    expect(listNotifications).toHaveBeenCalledWith(15, undefined, 0, ['session_scheduled', 'session_webhook'])
    expect(countNotifications).toHaveBeenCalledWith(undefined, ['session_scheduled', 'session_webhook'])
  })

  it('lists every type without ?types=', async () => {
    await notificationsRouter.request('/?limit=15')
    expect(listNotifications).toHaveBeenCalledWith(15, undefined, 0, undefined)
  })

  it('rejects an unknown type instead of showing everything', async () => {
    const res = await notificationsRouter.request('/?types=session_waiting,bogus')
    expect(res.status).toBe(400)
    expect(listNotifications).not.toHaveBeenCalled()
  })

  it('serves badge and per-type counts together', async () => {
    const res = await notificationsRouter.request('/unread-count')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 3, mentions: 1, types: {} })
  })

  it('read-all narrows to the body types', async () => {
    const res = await notificationsRouter.request('/read-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ types: ['session_complete'] }),
    })
    expect(res.status).toBe(200)
    expect(markAllAsRead).toHaveBeenCalledWith(undefined, ['session_complete'], undefined)
    expect(notificationReadAgentSlugs).toHaveBeenCalledWith({ kind: 'all', types: ['session_complete'] }, undefined)
  })

  it('read-all with no body reads everything', async () => {
    const res = await notificationsRouter.request('/read-all', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(markAllAsRead).toHaveBeenCalledWith(undefined, undefined, undefined)
  })

  it('passes a validated originating cache ID to every read write', async () => {
    const { markAsRead, markSessionNotificationsRead } = await import('@shared/lib/services/notification-service')
    vi.mocked(markAsRead).mockResolvedValue(true)
    vi.mocked(markSessionNotificationsRead).mockResolvedValue(1)
    const source = crypto.randomUUID()
    for (const path of ['/n1/read', '/read-by-session/s1', '/read-all']) {
      expect((await notificationsRouter.request(path, { method: 'POST', headers: { 'X-Notification-Client': source } })).status).toBe(200)
    }
    expect(markAsRead).toHaveBeenCalledWith('n1', source)
    expect(markSessionNotificationsRead).toHaveBeenCalledWith('s1', undefined, source)
    expect(markAllAsRead).toHaveBeenCalledWith(undefined, undefined, source)
    await notificationsRouter.request('/read-all', { method: 'POST', headers: { 'X-Notification-Client': 'bad-id' } })
    expect(markAllAsRead).toHaveBeenLastCalledWith(undefined, undefined, undefined)
  })

  it('read-all rejects a malformed body', async () => {
    for (const body of ['{not json', JSON.stringify({ types: ['bogus'] }), JSON.stringify({ types: [] })]) {
      const res = await notificationsRouter.request('/read-all', { method: 'POST', body })
      expect(res.status).toBe(400)
    }
    expect(markAllAsRead).not.toHaveBeenCalled()
  })
})

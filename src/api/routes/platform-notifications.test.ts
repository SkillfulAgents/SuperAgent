import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

let mockProxyUrl: string | null = 'https://proxy.test.example'
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => mockProxyUrl,
}))

let mockToken: string | null = 'pk_test'
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockToken,
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ platformAuth: { memberId: 'sub_member_1' } }),
}))

const mockListNotifications = vi.fn()
const mockMarkRead = vi.fn()
vi.mock('@shared/lib/services/platform-notifications-client', () => ({
  listPlatformNotifications: (...args: unknown[]) => mockListNotifications(...args),
  markPlatformNotificationsRead: (...args: unknown[]) => mockMarkRead(...args),
}))

// Auth middleware: no-op in tests
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

import platformNotificationsRouter from './platform-notifications'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NTF_1 = 'ntf_00000001-1111-1111-1111-111111111111'
const NTF_2 = 'ntf_00000002-2222-2222-2222-222222222222'

const LIST_RESPONSE = {
  notifications: [
    {
      id: NTF_1,
      org_id: null,
      title: 'Hello',
      body: 'World',
      action_url: null,
      kind: 'broadcast',
      read_at: null,
      expires_at: null,
      created_at: '2026-07-08T00:00:00+00:00',
    },
  ],
  total: 1,
  unread_count: 1,
}

const DISCONNECTED_LIST = { notifications: [], total: 0, unread_count: 0, connected: false }

function makeApp() {
  const app = new Hono()
  app.route('/api/platform-notifications', platformNotificationsRouter)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProxyUrl = 'https://proxy.test.example'
  mockToken = 'pk_test'
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/platform-notifications', () => {
  it('relays the platform list with connected: true', async () => {
    mockListNotifications.mockResolvedValue(LIST_RESPONSE)
    const res = await makeApp().request('/api/platform-notifications?status=unread&limit=20&offset=15')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ...LIST_RESPONSE, connected: true })
    expect(mockListNotifications).toHaveBeenCalledWith(
      { status: 'unread', limit: 20, offset: 15 },
      'sub_member_1',
    )
  })

  it('returns the disconnected shape without touching the client when not connected', async () => {
    mockToken = null
    const res = await makeApp().request('/api/platform-notifications')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(DISCONNECTED_LIST)
    expect(mockListNotifications).not.toHaveBeenCalled()
  })

  it('degrades an upstream failure to the disconnected shape, not a 502', async () => {
    // The everyday laptop-offline case: platform auth configured, proxy
    // unreachable. A 5xx here would spin the renderer's polling queries
    // through retry cycles and Sentry captures forever.
    mockListNotifications.mockRejectedValue(new Error('fetch failed'))
    const res = await makeApp().request('/api/platform-notifications')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(DISCONNECTED_LIST)
  })

  it('drops non-numeric pagination params and clamps out-of-range ones', async () => {
    mockListNotifications.mockResolvedValue(LIST_RESPONSE)
    const app = makeApp()

    await app.request('/api/platform-notifications?limit=abc&offset=xyz')
    expect(mockListNotifications).toHaveBeenLastCalledWith(
      { status: undefined, limit: undefined, offset: undefined },
      'sub_member_1',
    )

    await app.request('/api/platform-notifications?limit=500&offset=-3')
    expect(mockListNotifications).toHaveBeenLastCalledWith(
      { status: undefined, limit: 100, offset: 0 },
      'sub_member_1',
    )
  })
})

describe('GET /api/platform-notifications/unread-count', () => {
  it('returns the unread count', async () => {
    mockListNotifications.mockResolvedValue({ ...LIST_RESPONSE, unread_count: 7 })
    const res = await makeApp().request('/api/platform-notifications/unread-count')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 7 })
    expect(mockListNotifications).toHaveBeenCalledWith(
      { status: 'unread', limit: 1 },
      'sub_member_1',
    )
  })

  it('degrades an upstream failure to a zero badge, not a 502', async () => {
    mockListNotifications.mockRejectedValue(new Error('fetch failed'))
    const res = await makeApp().request('/api/platform-notifications/unread-count')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 0 })
  })
})

describe('POST /api/platform-notifications/read', () => {
  function postRead(body: unknown) {
    return makeApp().request('/api/platform-notifications/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('acks the given ids and reports the updated count', async () => {
    mockMarkRead.mockResolvedValue(2)
    const res = await postRead({ ids: [NTF_1, NTF_2] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, updated: 2 })
    expect(mockMarkRead).toHaveBeenCalledWith([NTF_1, NTF_2], 'sub_member_1')
  })

  it('rejects missing, empty, or non-array ids with 400', async () => {
    for (const body of [{}, { ids: [] }, { ids: 'ntf_x' }, { ids: 5 }, { ids: [1, 2] }]) {
      const res = await postRead(body)
      expect(res.status).toBe(400)
    }
    expect(mockMarkRead).not.toHaveBeenCalled()
  })

  it('returns 409 when the platform is not connected', async () => {
    mockToken = null
    const res = await postRead({ ids: [NTF_1] })
    expect(res.status).toBe(409)
    expect(mockMarkRead).not.toHaveBeenCalled()
  })

  it('surfaces an upstream failure as 502 (user-initiated, unlike the polled reads)', async () => {
    mockMarkRead.mockRejectedValue(new Error('fetch failed'))
    const res = await postRead({ ids: [NTF_1] })
    expect(res.status).toBe(502)
  })
})

describe('POST /api/platform-notifications/read-all', () => {
  function postReadAll() {
    return makeApp().request('/api/platform-notifications/read-all', { method: 'POST' })
  }

  it('resolves the unread page and acks those ids', async () => {
    mockListNotifications.mockResolvedValue({
      notifications: [{ ...LIST_RESPONSE.notifications[0] }, { ...LIST_RESPONSE.notifications[0], id: NTF_2 }],
      total: 2,
      unread_count: 2,
    })
    mockMarkRead.mockResolvedValue(2)

    const res = await postReadAll()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, updated: 2 })
    expect(mockListNotifications).toHaveBeenCalledWith(
      { status: 'unread', limit: 100 },
      'sub_member_1',
    )
    expect(mockMarkRead).toHaveBeenCalledWith([NTF_1, NTF_2], 'sub_member_1')
  })

  it('skips the ack call when nothing is unread', async () => {
    mockListNotifications.mockResolvedValue({ notifications: [], total: 0, unread_count: 0 })
    const res = await postReadAll()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, updated: 0 })
    expect(mockMarkRead).not.toHaveBeenCalled()
  })

  it('no-ops with success when the platform is not connected', async () => {
    mockToken = null
    const res = await postReadAll()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, updated: 0 })
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ============================================================================
// Mocks
// ============================================================================

let mockToken: string | null = 'pk_test_opaque'
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockToken,
}))

let mockOrgId: string | null = null
vi.mock('@shared/lib/platform-attribution', () => ({
  decodeOrgIdFromToken: () => mockOrgId,
}))

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.test.example',
}))

import {
  listPlatformNotifications,
  getNotificationsRealtimeConfig,
  markPlatformNotificationsRead,
} from './platform-notifications-client'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const LIST_RESPONSE = {
  notifications: [
    {
      id: 'ntf_11111111-1111-1111-1111-111111111111',
      org_id: null,
      title: 'Hello',
      body: '**md**',
      action_url: null,
      kind: 'broadcast',
      read_at: null,
      expires_at: null,
      created_at: '2026-07-01T00:00:00Z',
    },
  ],
  total: 1,
  unread_count: 1,
}

beforeEach(() => {
  globalThis.fetch = vi.fn()
  mockToken = 'pk_test_opaque'
  mockOrgId = null
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('platform-notifications-client', () => {
  it('lists notifications with query params and parses the response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse(LIST_RESPONSE))

    const result = await listPlatformNotifications(
      { status: 'unread', limit: 10, offset: 5 },
      'sub_member',
    )
    expect(result.notifications).toHaveLength(1)
    expect(result.notifications[0].title).toBe('Hello')
    expect(result.unread_count).toBe(1)

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]
    expect(String(url)).toBe(
      'https://proxy.test.example/v1/notifications?status=unread&limit=10&offset=5',
    )
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer pk_test_opaque')
  })

  it('appends ::memberId to the bearer for org JWTs only', async () => {
    mockOrgId = 'org_1'
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse(LIST_RESPONSE))

    await listPlatformNotifications({}, 'sub_member')

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1]
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer pk_test_opaque::sub_member',
    )
  })

  it('rejects a malformed list response at the Zod boundary', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({ notifications: [{ id: 42 }], total: 'x' }),
    )

    await expect(listPlatformNotifications({}, 'local')).rejects.toThrow()
  })

  it('throws a descriptive error on non-2xx responses', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('nope', { status: 502 }))

    await expect(listPlatformNotifications({}, 'local')).rejects.toThrow(
      /Platform notifications API error 502/,
    )
  })

  it('throws when no platform token is available', async () => {
    mockToken = null
    await expect(listPlatformNotifications({}, 'local')).rejects.toThrow(
      /Platform access token not available/,
    )
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled()
  })

  it('returns the parsed realtime config (including the table)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({
        realtime: {
          url: 'wss://x.supabase.co/realtime/v1',
          apikey: 'anon',
          jwt: 'jwt',
          channel: 'realtime:public:notifications',
          table: 'notifications',
        },
      }),
    )

    const config = await getNotificationsRealtimeConfig('local')
    expect(config?.table).toBe('notifications')

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]
    expect(String(url)).toBe('https://proxy.test.example/v1/notifications/realtime')
    expect(init?.method).toBe('POST')
  })

  it('returns null when the proxy has no acting-user context', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse({ realtime: null }))
    await expect(getNotificationsRealtimeConfig('local')).resolves.toBeNull()
  })

  it('marks notifications read and returns the updated count', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse({ ok: true, updated: 2 }))

    const updated = await markPlatformNotificationsRead(
      ['ntf_11111111-1111-1111-1111-111111111111', 'ntf_22222222-2222-2222-2222-222222222222'],
      'local',
    )
    expect(updated).toBe(2)

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]
    expect(String(url)).toBe('https://proxy.test.example/v1/notifications/read')
    expect(JSON.parse(init?.body as string).ids).toHaveLength(2)
  })

  it('short-circuits mark-read for an empty ids array', async () => {
    await expect(markPlatformNotificationsRead([], 'local')).resolves.toBe(0)
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ============================================================================
// Mocks
// ============================================================================

let mockIsAuthMode = false
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode,
}))

let mockProxyUrl: string | null = 'https://proxy.test.example'
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => mockProxyUrl,
}))

let mockToken: string | null = 'pk_test'
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockToken,
}))

let mockSettings: Record<string, unknown> = {}
const mockMutateSettings = vi.fn((mutator: (s: Record<string, unknown>) => void) => {
  mutator(mockSettings)
  return mockSettings
})
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockSettings,
  mutateSettings: (mutator: (s: Record<string, unknown>) => void) => mockMutateSettings(mutator),
}))

const mockBroadcastGlobal = vi.fn()
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    broadcastGlobal: (...args: unknown[]) => mockBroadcastGlobal(...args),
  },
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

let mockUserNotificationSettings: Record<string, boolean> = { enabled: true }
vi.mock('@shared/lib/services/user-settings-service', () => ({
  getUserSettings: () => ({ notifications: mockUserNotificationSettings }),
}))

const mockGetRealtimeConfig = vi.fn()
const mockListNotifications = vi.fn()
vi.mock('@shared/lib/services/platform-notifications-client', () => ({
  getNotificationsRealtimeConfig: (...args: unknown[]) => mockGetRealtimeConfig(...args),
  listPlatformNotifications: (...args: unknown[]) => mockListNotifications(...args),
}))

// Fake realtime client capturing connect() so tests can inject INSERT records,
// flip liveness, and fail the websocket handshake.
type EventCallback = (record: unknown) => void
const realtimeInstances: Array<{
  config: unknown
  onEvent: EventCallback | null
  active: boolean
  disconnect: ReturnType<typeof vi.fn>
  updateToken: ReturnType<typeof vi.fn>
}> = []
let mockConnectError: Error | null = null
vi.mock('@shared/lib/services/supabase-realtime-client', () => ({
  SupabaseRealtimeClient: class {
    config: unknown = null
    onEvent: EventCallback | null = null
    active = false
    disconnect = vi.fn(() => {
      this.active = false
    })
    updateToken = vi.fn()
    isActive() {
      return this.active
    }
    async connect(config: unknown, onEvent: EventCallback) {
      this.config = config
      this.onEvent = onEvent
      realtimeInstances.push(this)
      if (mockConnectError) {
        const err = mockConnectError
        mockConnectError = null
        throw err
      }
      this.active = true
    }
  },
}))

import { platformNotificationsManager } from './platform-notifications-manager'

// ============================================================================
// Fixtures
// ============================================================================

const REALTIME_CONFIG = {
  url: 'wss://x.supabase.co/realtime/v1',
  apikey: 'anon',
  jwt: 'jwt-1',
  channel: 'realtime:public:notifications',
  table: 'notifications',
}

function record(id: string, createdAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Title ${id}`,
    body: 'markdown body',
    created_at: createdAt,
    ...overrides,
  }
}

function osNotificationBroadcasts() {
  return mockBroadcastGlobal.mock.calls.filter(
    (call) => (call[0] as { type?: string }).type === 'os_notification',
  )
}

function changedBroadcasts() {
  return mockBroadcastGlobal.mock.calls.filter(
    (call) => (call[0] as { type?: string }).type === 'platform_notifications_changed',
  )
}

async function startWithDefaults(): Promise<EventCallback> {
  mockGetRealtimeConfig.mockResolvedValue(REALTIME_CONFIG)
  // Newest existing row — seeds the watermark on first start.
  mockListNotifications.mockResolvedValue({
    notifications: [record('ntf_seed', '2026-07-01T00:00:00Z')],
    total: 1,
    unread_count: 1,
  })
  await platformNotificationsManager.start()
  const instance = realtimeInstances[realtimeInstances.length - 1]
  expect(instance).toBeDefined()
  return instance.onEvent!
}

const JWT_REFRESH_INTERVAL_MS = 50 * 60 * 1000

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  realtimeInstances.length = 0
  mockConnectError = null
  mockIsAuthMode = false
  mockProxyUrl = 'https://proxy.test.example'
  mockToken = 'pk_test'
  mockSettings = { platformAuth: { memberId: 'sub_member_1' } }
  mockUserNotificationSettings = { enabled: true }
  platformNotificationsManager.stop()
})

// ============================================================================
// Tests
// ============================================================================

describe('PlatformNotificationsManager', () => {
  it('does not start in auth mode', async () => {
    mockIsAuthMode = true
    await platformNotificationsManager.start()
    expect(platformNotificationsManager.isActive()).toBe(false)
    expect(mockGetRealtimeConfig).not.toHaveBeenCalled()
  })

  it('does not start without a platform connection', async () => {
    mockToken = null
    await platformNotificationsManager.start()
    expect(platformNotificationsManager.isActive()).toBe(false)
    expect(mockGetRealtimeConfig).not.toHaveBeenCalled()
  })

  it('subscribes with the platform-minted config and seeds the watermark', async () => {
    const onEvent = await startWithDefaults()
    expect(platformNotificationsManager.isActive()).toBe(true)
    expect(realtimeInstances[0].config).toEqual(REALTIME_CONFIG)
    expect(mockGetRealtimeConfig).toHaveBeenCalledWith('sub_member_1')

    // The seed row (already existing before subscribe) must never OS-notify.
    onEvent(record('ntf_seed', '2026-07-01T00:00:00Z'))
    expect(osNotificationBroadcasts()).toHaveLength(0)
  })

  it('retries a null config on the refresh tick and subscribes once one is minted', async () => {
    vi.useFakeTimers()
    mockGetRealtimeConfig.mockResolvedValueOnce(null)
    await platformNotificationsManager.start()
    expect(platformNotificationsManager.isActive()).toBe(true)
    expect(realtimeInstances).toHaveLength(0)

    // e.g. an auth cache entry that predates the userId claim gets revalidated
    mockGetRealtimeConfig.mockResolvedValue(REALTIME_CONFIG)
    mockListNotifications.mockResolvedValue({ notifications: [], total: 0, unread_count: 0 })
    await vi.advanceTimersByTimeAsync(JWT_REFRESH_INTERVAL_MS)

    expect(realtimeInstances).toHaveLength(1)
    expect(platformNotificationsManager.isRealtimeActive()).toBe(true)
  })

  it('refreshes the JWT on the 50-minute tick while the subscription is live', async () => {
    vi.useFakeTimers()
    await startWithDefaults()
    const instance = realtimeInstances[0]

    mockGetRealtimeConfig.mockResolvedValue({ ...REALTIME_CONFIG, jwt: 'jwt-2' })
    await vi.advanceTimersByTimeAsync(JWT_REFRESH_INTERVAL_MS)

    expect(instance.updateToken).toHaveBeenCalledWith('jwt-2')
    // Still the same subscription — no churn while healthy.
    expect(realtimeInstances).toHaveLength(1)
  })

  it('reconnects on the refresh tick when the subscription has died', async () => {
    vi.useFakeTimers()
    await startWithDefaults()
    realtimeInstances[0].active = false // e.g. reconnect attempts exhausted

    await vi.advanceTimersByTimeAsync(JWT_REFRESH_INTERVAL_MS)

    expect(realtimeInstances).toHaveLength(2)
    expect(platformNotificationsManager.isRealtimeActive()).toBe(true)
  })

  it('installs the retry cadence even when the initial websocket connect fails', async () => {
    // A connection-refused at launch must not hang start() or strand the
    // manager without its refresh interval (the realtime JWT only lasts 1h).
    vi.useFakeTimers()
    mockConnectError = new Error('WebSocket closed before connection established')
    await startWithDefaults()
    expect(platformNotificationsManager.isRealtimeActive()).toBe(false)

    await vi.advanceTimersByTimeAsync(JWT_REFRESH_INTERVAL_MS)

    expect(realtimeInstances).toHaveLength(2)
    expect(platformNotificationsManager.isRealtimeActive()).toBe(true)
  })

  it('a stale in-flight connect from before a stop/start cannot clobber the new subscription', async () => {
    vi.useFakeTimers()
    mockListNotifications.mockResolvedValue({ notifications: [], total: 0, unread_count: 0 })

    // start #1 blocks on the realtime-config mint...
    let resolveMint: (config: unknown) => void = () => {}
    mockGetRealtimeConfig.mockImplementationOnce(
      () => new Promise((resolve) => (resolveMint = resolve)),
    )
    const firstStart = platformNotificationsManager.start()

    // ...meanwhile the platform disconnects and reconnects (new identity).
    platformNotificationsManager.stop()
    mockGetRealtimeConfig.mockResolvedValue({ ...REALTIME_CONFIG, jwt: 'jwt-fresh' })
    await platformNotificationsManager.start()
    expect(realtimeInstances).toHaveLength(1)
    const current = realtimeInstances[0]

    // The stale mint resolving must not resubscribe with the old identity,
    // disconnect the current client, or double-install the refresh interval.
    resolveMint({ ...REALTIME_CONFIG, jwt: 'jwt-stale' })
    await firstStart

    expect(realtimeInstances).toHaveLength(1)
    expect(current.disconnect).not.toHaveBeenCalled()
    expect(platformNotificationsManager.isRealtimeActive()).toBe(true)

    // Exactly one refresh interval: one tick mints exactly one config.
    mockGetRealtimeConfig.mockClear()
    await vi.advanceTimersByTimeAsync(JWT_REFRESH_INTERVAL_MS)
    expect(mockGetRealtimeConfig).toHaveBeenCalledTimes(1)
  })

  it('does not re-notify a reconnect replay of the newest row after a restart', async () => {
    // Restart clears the in-session id-set; only the persisted watermark
    // stands between a replayed INSERT (created_at equal to the watermark)
    // and a duplicate OS notification.
    const onEvent = await startWithDefaults()
    onEvent(record('ntf_new', '2026-07-02T00:00:00Z'))
    expect(osNotificationBroadcasts()).toHaveLength(1)

    platformNotificationsManager.stop()
    const onEventAfterRestart = await startWithDefaults()
    onEventAfterRestart(record('ntf_new', '2026-07-02T00:00:00Z'))

    expect(osNotificationBroadcasts()).toHaveLength(1)
  })

  it('fires one OS notification per INSERT and always signals the inbox', async () => {
    const onEvent = await startWithDefaults()

    onEvent(
      record('ntf_new', '2026-07-02T00:00:00Z', {
        body: 'This is **markdown** with a [link](https://example.com).\n\n- bullet',
      }),
    )

    expect(changedBroadcasts()).toHaveLength(1)
    const osNotifs = osNotificationBroadcasts()
    expect(osNotifs).toHaveLength(1)
    expect(osNotifs[0][0]).toMatchObject({
      type: 'os_notification',
      notificationType: 'platform_notification',
      platformNotificationId: 'ntf_new',
      title: 'Title ntf_new',
      // OS notifications render plain text: markdown syntax must be stripped.
      body: 'This is markdown with a link. bullet',
      actionContext: {
        kind: 'platform_notification',
        platformNotificationId: 'ntf_new',
      },
    })
  })

  it('dedups reconnect replays by id and backdated inserts by watermark', async () => {
    const onEvent = await startWithDefaults()

    onEvent(record('ntf_new', '2026-07-02T00:00:00Z'))
    onEvent(record('ntf_new', '2026-07-02T00:00:00Z')) // replay
    onEvent(record('ntf_backdated', '2026-06-01T00:00:00Z')) // older than watermark

    expect(osNotificationBroadcasts()).toHaveLength(1)
    // The inbox signal still fires for every INSERT (live page update).
    expect(changedBroadcasts()).toHaveLength(3)
  })

  it('persists the advanced watermark', async () => {
    const onEvent = await startWithDefaults()
    onEvent(record('ntf_new', '2026-07-02T00:00:00Z'))

    expect(
      (mockSettings.platformNotifications as { lastNotifiedAt?: string }).lastNotifiedAt,
    ).toBe('2026-07-02T00:00:00Z')
  })

  it('prefers the persisted watermark over the list seed', async () => {
    mockSettings.platformNotifications = { lastNotifiedAt: '2026-07-03T00:00:00Z' }
    const onEvent = await startWithDefaults()
    // No list seed needed — and an insert older than the persisted watermark
    // stays silent.
    onEvent(record('ntf_old', '2026-07-02T12:00:00Z'))
    expect(osNotificationBroadcasts()).toHaveLength(0)

    onEvent(record('ntf_newer', '2026-07-04T00:00:00Z'))
    expect(osNotificationBroadcasts()).toHaveLength(1)
  })

  it('suppresses the OS notification when the settings toggle is off', async () => {
    mockUserNotificationSettings = { enabled: true, platformNotification: false }
    const onEvent = await startWithDefaults()

    onEvent(record('ntf_new', '2026-07-02T00:00:00Z'))

    expect(osNotificationBroadcasts()).toHaveLength(0)
    expect(changedBroadcasts()).toHaveLength(1) // inbox still updates
  })

  it('drops records that fail schema validation', async () => {
    const onEvent = await startWithDefaults()

    onEvent({ id: 'ntf_bad' }) // missing title/body/created_at

    expect(osNotificationBroadcasts()).toHaveLength(0)
    expect(changedBroadcasts()).toHaveLength(0)
  })

  it('stop() disconnects the realtime client', async () => {
    await startWithDefaults()
    platformNotificationsManager.stop()
    expect(realtimeInstances[0].disconnect).toHaveBeenCalled()
    expect(platformNotificationsManager.isActive()).toBe(false)
  })
})

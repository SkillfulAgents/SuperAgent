import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  listDeliverableApnsDevices: vi.fn((): unknown[] => []),
  deleteApnsDeviceById: vi.fn(),
  getApnsRelayConfig: vi.fn(
    (): { url: string | null; enabled: boolean } => ({
      url: 'https://relay.example',
      enabled: true,
    })
  ),
  isAuthMode: vi.fn(() => false),
  getUserSettings: vi.fn(() => ({
    notifications: {
      enabled: true,
      sessionComplete: true,
      sessionWaiting: true,
      sessionScheduled: true,
      platformNotification: true,
      notifyWhenUnfocused: false,
    },
  })),
  getAccessibleAgentSlugs: vi.fn(async (_userId: string): Promise<string[]> => []),
  getSessionMetadata: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
}))

vi.mock('../push/apns-device-service', () => ({
  listDeliverableApnsDevices: mocks.listDeliverableApnsDevices,
  deleteApnsDeviceById: mocks.deleteApnsDeviceById,
}))
vi.mock('@shared/lib/config/settings', () => ({
  getApnsRelayConfig: mocks.getApnsRelayConfig,
}))
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: mocks.isAuthMode,
}))
vi.mock('@shared/lib/services/user-settings-service', () => ({
  getUserSettings: mocks.getUserSettings,
}))
vi.mock('@shared/lib/services/notification-service', () => ({
  getAccessibleAgentSlugs: mocks.getAccessibleAgentSlugs,
}))
vi.mock('@shared/lib/services/session-service', () => ({
  getSessionMetadata: mocks.getSessionMetadata,
}))

vi.stubGlobal('fetch', mocks.fetch)

import { ApnsRelayChannel } from './apns-relay-channel'
import type { NotificationEvent } from '../notification-event'

const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    notificationId: 'notif-1',
    type: 'session_complete',
    sessionId: 'sess-1',
    agentSlug: 'agent-x',
    title: 'Session Complete',
    body: 'Demo Agent has finished running',
    navigatePath: '/agents/agent-x/sessions/sess-1',
    ...overrides,
  }
}

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dev-row-1',
    token: TOKEN_A,
    environment: 'production',
    userId: null,
    mobileDeviceId: 'family-1',
    workspaceTag: 'ws-1',
    deviceName: 'iPhone',
    platform: 'ios',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

function relayOk(results: Array<{ deviceToken: string; status: number; reason?: string }>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results }),
  }
}

/** Every push sent across all fetch calls, in order. */
function sentPushes(): Array<Record<string, unknown>> {
  return mocks.fetch.mock.calls.flatMap(
    (call) => JSON.parse((call[1] as { body: string }).body).pushes
  )
}

const channel = new ApnsRelayChannel()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isAuthMode.mockReturnValue(false)
  mocks.getApnsRelayConfig.mockReturnValue({ url: 'https://relay.example', enabled: true })
  mocks.listDeliverableApnsDevices.mockReturnValue([makeDevice()])
  mocks.getSessionMetadata.mockResolvedValue(null)
  mocks.getAccessibleAgentSlugs.mockResolvedValue([])
  mocks.getUserSettings.mockReturnValue({
    notifications: {
      enabled: true,
      sessionComplete: true,
      sessionWaiting: true,
      sessionScheduled: true,
      platformNotification: true,
      notifyWhenUnfocused: false,
    },
  })
  mocks.fetch.mockResolvedValue(
    relayOk([{ deviceToken: TOKEN_A, status: 200 }]) as never
  )
})

describe('type gating', () => {
  it.each(['session_complete', 'session_waiting', 'session_scheduled', 'session_webhook'] as const)(
    'delivers %s (at least silently)',
    async (type) => {
      await channel.deliver(makeEvent({ type }))
      expect(mocks.fetch).toHaveBeenCalledTimes(1)
    }
  )

  it('never touches the relay for types outside the silent set', async () => {
    await channel.deliver(makeEvent({ type: 'session_chat_integration' }))
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.listDeliverableApnsDevices).not.toHaveBeenCalled()
  })
})

describe('kill switch / disabled config', () => {
  it('does nothing when the relay is disabled (null url)', async () => {
    mocks.getApnsRelayConfig.mockReturnValue({ url: null, enabled: false })
    await channel.deliver(makeEvent())
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('does nothing when no devices are registered', async () => {
    mocks.listDeliverableApnsDevices.mockReturnValue([])
    await channel.deliver(makeEvent())
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})

describe('origin-device alert routing', () => {
  it('origin device gets a visible alert; all others get background pushes', async () => {
    mocks.listDeliverableApnsDevices.mockReturnValue([
      makeDevice(),
      makeDevice({ id: 'dev-row-2', token: TOKEN_B, mobileDeviceId: 'family-2' }),
    ])
    mocks.getSessionMetadata.mockResolvedValue({ createdByDeviceId: 'family-1' })

    await channel.deliver(makeEvent())

    const pushes = sentPushes()
    expect(pushes).toHaveLength(2)
    const alert = pushes.find((p) => p.deviceToken === TOKEN_A)!
    const background = pushes.find((p) => p.deviceToken === TOKEN_B)!
    expect(alert.kind).toBe('alert')
    expect(alert.alert).toEqual({
      title: 'Session Complete',
      body: 'Demo Agent has finished running',
    })
    expect(alert.data).toMatchObject({
      type: 'session_complete',
      notificationId: 'notif-1',
      sessionId: 'sess-1',
      agentSlug: 'agent-x',
      navigatePath: '/agents/agent-x/sessions/sess-1',
      workspaceId: 'ws-1',
    })
    expect(background.kind).toBe('background')
    expect(background.alert).toBeUndefined()
  })

  it('an alertDeviceId claim overrides the creation stamp', async () => {
    mocks.listDeliverableApnsDevices.mockReturnValue([
      makeDevice(),
      makeDevice({ id: 'dev-row-2', token: TOKEN_B, mobileDeviceId: 'family-2' }),
    ])
    // Created on family-1, but family-2 spoke last — the alert follows it.
    mocks.getSessionMetadata.mockResolvedValue({
      createdByDeviceId: 'family-1',
      alertDeviceId: 'family-2',
    })

    await channel.deliver(makeEvent())

    const pushes = sentPushes()
    expect(pushes.find((p) => p.deviceToken === TOKEN_A)!.kind).toBe('background')
    expect(pushes.find((p) => p.deviceToken === TOKEN_B)!.kind).toBe('alert')
  })

  it('a null alertDeviceId (web spoke last) silences everyone despite a creation stamp', async () => {
    mocks.listDeliverableApnsDevices.mockReturnValue([makeDevice()])
    mocks.getSessionMetadata.mockResolvedValue({
      createdByDeviceId: 'family-1',
      alertDeviceId: null,
    })

    await channel.deliver(makeEvent())

    expect(sentPushes()[0].kind).toBe('background')
  })

  it('a session with no origin (web/cron/webhook) is silent to everyone', async () => {
    mocks.listDeliverableApnsDevices.mockReturnValue([
      makeDevice(),
      makeDevice({ id: 'dev-row-2', token: TOKEN_B, mobileDeviceId: 'family-2' }),
    ])
    mocks.getSessionMetadata.mockResolvedValue({})

    await channel.deliver(makeEvent())

    const pushes = sentPushes()
    expect(pushes).toHaveLength(2)
    expect(pushes.every((p) => p.kind === 'background')).toBe(true)
  })

  it('a device row with no mobileDeviceId can never be the origin', async () => {
    mocks.listDeliverableApnsDevices.mockReturnValue([makeDevice({ mobileDeviceId: null })])
    // A null metadata stamp must not match a null mobileDeviceId.
    mocks.getSessionMetadata.mockResolvedValue({ createdByDeviceId: undefined })

    await channel.deliver(makeEvent())

    expect(sentPushes()[0].kind).toBe('background')
  })

  it('silent-only types are background even on the origin device', async () => {
    mocks.getSessionMetadata.mockResolvedValue({ createdByDeviceId: 'family-1' })

    await channel.deliver(makeEvent({ type: 'session_scheduled' }))

    expect(sentPushes()[0].kind).toBe('background')
  })

  it('metadata read failure degrades to no-origin (all background), not to no delivery', async () => {
    mocks.getSessionMetadata.mockRejectedValue(new Error('corrupt metadata'))

    await channel.deliver(makeEvent())

    expect(sentPushes()[0].kind).toBe('background')
  })
})

describe('owner settings gate', () => {
  it('prefs-disabled type degrades the origin device to background — never to nothing', async () => {
    mocks.getSessionMetadata.mockResolvedValue({ createdByDeviceId: 'family-1' })
    mocks.getUserSettings.mockReturnValue({
      notifications: {
        enabled: true,
        sessionComplete: false,
        sessionWaiting: true,
        sessionScheduled: true,
        platformNotification: true,
        notifyWhenUnfocused: false,
      },
    })

    await channel.deliver(makeEvent({ type: 'session_complete' }))

    const pushes = sentPushes()
    expect(pushes).toHaveLength(1)
    expect(pushes[0].kind).toBe('background')
  })

  it('resolves settings per owner — local sentinel in local mode, user id in auth mode', async () => {
    mocks.getSessionMetadata.mockResolvedValue({ createdByDeviceId: 'family-1' })

    await channel.deliver(makeEvent())
    expect(mocks.getUserSettings).toHaveBeenCalledWith('local')

    mocks.isAuthMode.mockReturnValue(true)
    mocks.getAccessibleAgentSlugs.mockResolvedValue(['agent-x'])
    mocks.listDeliverableApnsDevices.mockReturnValue([makeDevice({ userId: 'user-a' })])
    await channel.deliver(makeEvent())
    expect(mocks.getUserSettings).toHaveBeenCalledWith('user-a')
  })
})

describe('auth-mode agent access gate', () => {
  beforeEach(() => {
    mocks.isAuthMode.mockReturnValue(true)
  })

  it('skips owners without access to the event agent — silent pushes too', async () => {
    mocks.listDeliverableApnsDevices.mockReturnValue([
      makeDevice({ userId: 'user-a' }),
      makeDevice({ id: 'dev-row-2', token: TOKEN_B, userId: 'user-b', mobileDeviceId: 'family-2' }),
    ])
    mocks.getAccessibleAgentSlugs.mockImplementation(async (userId: string) =>
      userId === 'user-a' ? ['agent-x'] : ['agent-other']
    )

    await channel.deliver(makeEvent())

    const pushes = sentPushes()
    expect(pushes).toHaveLength(1)
    expect(pushes[0].deviceToken).toBe(TOKEN_A)
  })

  it('never delivers to ownerless device rows in auth mode', async () => {
    mocks.listDeliverableApnsDevices.mockReturnValue([makeDevice({ userId: null })])

    await channel.deliver(makeEvent())

    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})

describe('relay result handling', () => {
  it.each([
    { status: 410, reason: 'Unregistered' },
    { status: 410, reason: undefined },
    { status: 400, reason: 'BadDeviceToken' },
    { status: 400, reason: 'DeviceTokenNotForTopic' },
  ])('prunes the device on $status/$reason', async ({ status, reason }) => {
    mocks.fetch.mockResolvedValue(
      relayOk([{ deviceToken: TOKEN_A, status, reason }]) as never
    )

    await channel.deliver(makeEvent())

    expect(mocks.deleteApnsDeviceById).toHaveBeenCalledWith('dev-row-1')
  })

  it('does NOT prune on RelayRateLimited (429) or RelayFetchFailed (0)', async () => {
    mocks.listDeliverableApnsDevices.mockReturnValue([
      makeDevice(),
      makeDevice({ id: 'dev-row-2', token: TOKEN_B, mobileDeviceId: 'family-2' }),
    ])
    mocks.fetch.mockResolvedValue(
      relayOk([
        { deviceToken: TOKEN_A, status: 429, reason: 'RelayRateLimited' },
        { deviceToken: TOKEN_B, status: 0, reason: 'RelayFetchFailed' },
      ]) as never
    )

    await channel.deliver(makeEvent())

    expect(mocks.deleteApnsDeviceById).not.toHaveBeenCalled()
  })

  it('one dead token does not affect the others', async () => {
    mocks.listDeliverableApnsDevices.mockReturnValue([
      makeDevice(),
      makeDevice({ id: 'dev-row-2', token: TOKEN_B, mobileDeviceId: 'family-2' }),
    ])
    mocks.fetch.mockResolvedValue(
      relayOk([
        { deviceToken: TOKEN_A, status: 410, reason: 'Unregistered' },
        { deviceToken: TOKEN_B, status: 200 },
      ]) as never
    )

    await channel.deliver(makeEvent())

    expect(mocks.deleteApnsDeviceById).toHaveBeenCalledTimes(1)
    expect(mocks.deleteApnsDeviceById).toHaveBeenCalledWith('dev-row-1')
  })

  it('a network failure is swallowed and prunes nothing', async () => {
    mocks.fetch.mockRejectedValue(new Error('connect ETIMEDOUT'))

    await expect(channel.deliver(makeEvent())).resolves.toBeUndefined()
    expect(mocks.deleteApnsDeviceById).not.toHaveBeenCalled()
  })

  it('a non-200 relay response is swallowed and prunes nothing', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as never)

    await expect(channel.deliver(makeEvent())).resolves.toBeUndefined()
    expect(mocks.deleteApnsDeviceById).not.toHaveBeenCalled()
  })
})

describe('batching', () => {
  it('splits more than 50 pushes across multiple relay requests', async () => {
    const devices = Array.from({ length: 60 }, (_, i) =>
      makeDevice({
        id: `dev-row-${i}`,
        token: i.toString(16).padStart(64, '0'),
        mobileDeviceId: `family-${i}`,
      })
    )
    mocks.listDeliverableApnsDevices.mockReturnValue(devices)
    mocks.fetch.mockImplementation(async (_url: unknown, init: unknown) => {
      const pushes = JSON.parse((init as { body: string }).body).pushes as Array<{
        deviceToken: string
      }>
      return relayOk(pushes.map((p) => ({ deviceToken: p.deviceToken, status: 200 })))
    })

    await channel.deliver(makeEvent())

    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    const sizes = mocks.fetch.mock.calls.map(
      (call) => JSON.parse((call[1] as { body: string }).body).pushes.length
    )
    expect(sizes).toEqual([50, 10])
  })

  it('posts to {url}/push with a bounded timeout', async () => {
    await channel.deliver(makeEvent())

    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://relay.example/push')
    expect(init.method).toBe('POST')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

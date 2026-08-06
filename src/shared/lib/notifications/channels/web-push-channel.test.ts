import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(async (..._args: unknown[]) => ({ statusCode: 201 })),
  listPushSubscriptions: vi.fn((): unknown[] => []),
  deletePushSubscriptionById: vi.fn(),
  getVapidKeys: vi.fn(() => ({ publicKey: 'vapid-pub', privateKey: 'vapid-priv' })),
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
}))

vi.mock('web-push', () => ({
  default: { sendNotification: mocks.sendNotification },
}))
vi.mock('../push/push-subscription-service', () => ({
  listPushSubscriptions: mocks.listPushSubscriptions,
  deletePushSubscriptionById: mocks.deletePushSubscriptionById,
}))
vi.mock('../push/vapid-keys', () => ({
  getVapidKeys: mocks.getVapidKeys,
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

import { WebPushChannel } from './web-push-channel'
import type { NotificationEvent } from '../notification-event'

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

function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    endpoint: 'https://web.push.apple.com/abc',
    keysP256dh: 'p256dh-key',
    keysAuth: 'auth-secret',
    origin: 'https://host.tailnet.ts.net',
    userId: null,
    deviceName: 'iPhone',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

const channel = new WebPushChannel()

beforeEach(() => {
  // clearAllMocks drops call history but keeps sticky mockReturnValue/
  // mockImplementation overrides — re-establish every default explicitly.
  vi.clearAllMocks()
  mocks.sendNotification.mockResolvedValue({ statusCode: 201 } as never)
  mocks.isAuthMode.mockReturnValue(false)
  mocks.getVapidKeys.mockReturnValue({ publicKey: 'vapid-pub', privateKey: 'vapid-priv' })
  mocks.listPushSubscriptions.mockReturnValue([makeSubscription()])
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
  mocks.getAccessibleAgentSlugs.mockResolvedValue([])
})

describe('type allowlist', () => {
  it.each(['session_complete', 'session_waiting'] as const)('pushes %s', async (type) => {
    await channel.deliver(makeEvent({ type }))
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1)
  })

  it.each(['session_scheduled', 'session_webhook', 'session_chat_integration'] as const)(
    'never pushes %s — automation chatter stays off the phone',
    async (type) => {
      await channel.deliver(makeEvent({ type }))
      expect(mocks.sendNotification).not.toHaveBeenCalled()
      expect(mocks.listPushSubscriptions).not.toHaveBeenCalled()
    }
  )
})

describe('declarative payload', () => {
  it('sends the stable declarative core with navigate resolved on the subscription origin', async () => {
    await channel.deliver(makeEvent())

    const [target, payloadJson, options] = mocks.sendNotification.mock.calls[0] as unknown as [
      { endpoint: string; keys: { p256dh: string; auth: string } },
      string,
      { vapidDetails: { subject: string; publicKey: string; privateKey: string } },
    ]
    expect(target).toEqual({
      endpoint: 'https://web.push.apple.com/abc',
      keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
    })
    expect(JSON.parse(payloadJson)).toEqual({
      web_push: 8030,
      notification: {
        title: 'Session Complete',
        body: 'Demo Agent has finished running',
        navigate: 'https://host.tailnet.ts.net/agents/agent-x/sessions/sess-1',
      },
    })
    expect(options.vapidDetails).toEqual({
      subject: 'https://host.tailnet.ts.net',
      publicKey: 'vapid-pub',
      privateKey: 'vapid-priv',
    })
  })

  it('each subscription gets navigate built on its own origin', async () => {
    mocks.listPushSubscriptions.mockReturnValue([
      makeSubscription(),
      makeSubscription({ id: 'sub-2', endpoint: 'https://push/2', origin: 'https://other.example' }),
    ])

    await channel.deliver(makeEvent())

    const navigates = mocks.sendNotification.mock.calls.map(
      (call) => JSON.parse(call[1] as unknown as string).notification.navigate
    )
    expect(navigates.sort()).toEqual([
      'https://host.tailnet.ts.net/agents/agent-x/sessions/sess-1',
      'https://other.example/agents/agent-x/sessions/sess-1',
    ])
  })
})

describe('owner settings gate', () => {
  it('respects the per-type toggle of the subscription owner', async () => {
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
    expect(mocks.sendNotification).not.toHaveBeenCalled()

    await channel.deliver(makeEvent({ type: 'session_waiting' }))
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1)
  })

  it('resolves settings per owner — local sentinel for ownerless rows, user id otherwise', async () => {
    await channel.deliver(makeEvent())
    expect(mocks.getUserSettings).toHaveBeenCalledWith('local')

    mocks.isAuthMode.mockReturnValue(true)
    mocks.getAccessibleAgentSlugs.mockResolvedValue(['agent-x'])
    mocks.listPushSubscriptions.mockReturnValue([makeSubscription({ userId: 'user-a' })])
    await channel.deliver(makeEvent())
    expect(mocks.getUserSettings).toHaveBeenCalledWith('user-a')
  })
})

describe('auth-mode agent access gate', () => {
  beforeEach(() => {
    mocks.isAuthMode.mockReturnValue(true)
  })

  it('skips owners without access to the event agent', async () => {
    mocks.listPushSubscriptions.mockReturnValue([
      makeSubscription({ id: 'sub-a', userId: 'user-a' }),
      makeSubscription({ id: 'sub-b', endpoint: 'https://push/b', userId: 'user-b' }),
    ])
    mocks.getAccessibleAgentSlugs.mockImplementation(async (userId: string) =>
      userId === 'user-a' ? ['agent-x'] : ['agent-other']
    )

    await channel.deliver(makeEvent())

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1)
    const [target] = mocks.sendNotification.mock.calls[0] as unknown as [{ endpoint: string }]
    expect(target.endpoint).toBe('https://web.push.apple.com/abc')
  })

  it('never delivers to ownerless subscriptions in auth mode', async () => {
    mocks.listPushSubscriptions.mockReturnValue([makeSubscription({ userId: null })])

    await channel.deliver(makeEvent())

    expect(mocks.sendNotification).not.toHaveBeenCalled()
  })
})

describe('failure handling', () => {
  // 404/410 = subscription gone; 401/403 = push service rejects our VAPID
  // identity for it (row minted against a keypair we no longer hold) — all
  // permanently undeliverable, all pruned.
  it.each([401, 403, 404, 410])('prunes the subscription on %d', async (statusCode) => {
    mocks.sendNotification.mockRejectedValueOnce(
      Object.assign(new Error('undeliverable'), { statusCode })
    )

    await channel.deliver(makeEvent())

    expect(mocks.deletePushSubscriptionById).toHaveBeenCalledWith('sub-1')
  })

  it('keeps the subscription on transient errors and does not throw', async () => {
    mocks.sendNotification.mockRejectedValueOnce(
      Object.assign(new Error('server error'), { statusCode: 500 })
    )

    await expect(channel.deliver(makeEvent())).resolves.toBeUndefined()
    expect(mocks.deletePushSubscriptionById).not.toHaveBeenCalled()
  })

  it('one dead endpoint does not block delivery to the others', async () => {
    mocks.listPushSubscriptions.mockReturnValue([
      makeSubscription(),
      makeSubscription({ id: 'sub-2', endpoint: 'https://push/2' }),
    ])
    mocks.sendNotification
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
      .mockResolvedValueOnce({ statusCode: 201 })

    await channel.deliver(makeEvent())

    expect(mocks.sendNotification).toHaveBeenCalledTimes(2)
    expect(mocks.deletePushSubscriptionById).toHaveBeenCalledTimes(1)
  })

  it('skips sending entirely when VAPID keys are missing', async () => {
    mocks.getVapidKeys.mockReturnValue(null as never)

    await channel.deliver(makeEvent())

    expect(mocks.sendNotification).not.toHaveBeenCalled()
  })
})

describe('no subscriptions', () => {
  it('is a no-op without touching VAPID keys', async () => {
    mocks.listPushSubscriptions.mockReturnValue([])

    await channel.deliver(makeEvent())

    expect(mocks.getVapidKeys).not.toHaveBeenCalled()
    expect(mocks.sendNotification).not.toHaveBeenCalled()
  })
})

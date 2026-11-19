/**
 * Who a notification is pushed to, against a real database, for both push
 * channels: the recipient matrix (membership, account status, the tagged
 * person, per-user preferences, several devices, local mode), and how many
 * statements one notification costs as the workspace grows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@shared/lib/db/schema'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

let authMode = true
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => authMode }))

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(async (..._args: unknown[]) => ({ statusCode: 201 })),
  fetch: vi.fn(),
  sessionMetadata: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  appSettings: vi.fn((): Record<string, unknown> => ({})),
}))
vi.mock('web-push', () => ({ default: { sendNotification: mocks.sendNotification } }))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: { get: () => ({ sessions: { metadata: mocks.sessionMetadata } }) },
}))
vi.mock('@shared/lib/config/settings', () => ({
  getApnsRelayConfig: async () => ({ url: 'https://relay.example', enabled: true }),
  getSettings: async () => mocks.appSettings(),
}))
vi.stubGlobal('fetch', mocks.fetch)

import { WebPushChannel } from './web-push-channel'
import { ApnsRelayChannel } from './apns-relay-channel'
import type { NotificationEvent } from '../notification-event'

const AGENT = 'agent-x'
const OTHER_AGENT = 'agent-other'
const EPOCH = new Date(0)
const FAR_FUTURE = new Date('2999-01-01T00:00:00Z')

const webPush = new WebPushChannel()
const apns = new ApnsRelayChannel()

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    notificationId: 'notif-1',
    type: 'session_complete',
    sessionId: 'sess-1',
    agentSlug: AGENT,
    title: 'Session Complete',
    body: 'Demo Agent has finished running',
    navigatePath: `/agents/${AGENT}/sessions/sess-1`,
    ...overrides,
  }
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

async function addUser(id: string, fields: Partial<typeof schema.user.$inferInsert> = {}): Promise<void> {
  await testDb.insert(schema.user).values({ id, name: id, email: `${id}@example.test`, ...fields }).run()
}

async function addAccess(userId: string, agentSlug = AGENT, role: 'owner' | 'user' | 'viewer' = 'user'): Promise<void> {
  await testDb.insert(schema.agentAcl)
    .values({ id: `acl-${userId}-${agentSlug}`, userId, agentSlug, role, createdAt: EPOCH })
    .run()
}

async function setNotificationSettings(userId: string, notifications: Record<string, boolean>): Promise<void> {
  await testDb.insert(schema.userSettings)
    .values({ userId, settings: JSON.stringify({ notifications }), updatedAt: EPOCH })
    .run()
}

/** A browser subscription named `name`; its endpoint is what a send is recognised by. */
async function addSubscription(name: string, userId: string | null): Promise<void> {
  await testDb.insert(schema.pushSubscriptions).values({
    id: `sub-${name}`,
    endpoint: `https://push.example/${name}`,
    keysP256dh: 'p256dh',
    keysAuth: 'auth',
    origin: 'https://host.example',
    userId,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  }).run()
}

/** An iOS registration whose token is `name`; with `family`, tied to a paired mobile device. */
async function addDevice(
  name: string,
  userId: string | null,
  options: { family?: string; expiresAt?: Date } = {},
): Promise<void> {
  if (options.family && userId) {
    await testDb.insert(schema.mobileDevice).values({
      id: options.family,
      userId,
      refreshTokenHash: `hash-${options.family}`,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      expiresAt: options.expiresAt ?? FAR_FUTURE,
    }).run()
  }
  await testDb.insert(schema.apnsDevices).values({
    id: `dev-${name}`,
    token: name,
    userId,
    mobileDeviceId: options.family ?? null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  }).run()
}

/** A member of the agent with one browser subscription and one phone, both named after them. */
async function addMember(
  id: string,
  fields: Partial<typeof schema.user.$inferInsert> = {},
  role: 'owner' | 'user' | 'viewer' = 'user',
): Promise<void> {
  await addUser(id, fields)
  await addAccess(id, AGENT, role)
  await addSubscription(id, id)
  await addDevice(id, id, { family: `family-${id}` })
}

// ─── What went out ───────────────────────────────────────────────────────────

/** The names of the browser subscriptions a push was sent to, sorted. */
function webPushed(): string[] {
  return mocks.sendNotification.mock.calls
    .map((call) => (call[0] as { endpoint: string }).endpoint.replace('https://push.example/', ''))
    .sort()
}

/** Per device token, the kinds of push the relay was asked to send, sorted. */
function apnsPushed(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const call of mocks.fetch.mock.calls) {
    const { pushes } = JSON.parse((call[1] as { body: string }).body) as {
      pushes: Array<{ deviceToken: string; kind: string }>
    }
    for (const push of pushes) (out[push.deviceToken] ??= []).push(push.kind)
  }
  for (const kinds of Object.values(out)) kinds.sort()
  return out
}

async function deliver(overrides: Partial<NotificationEvent> = {}): Promise<void> {
  const event = makeEvent(overrides)
  await webPush.deliver(event)
  await apns.deliver(event)
}

beforeEach(async () => {
  authMode = true
  handle = await createTestDatabase()
  testDb = handle.db
  vi.clearAllMocks()
  mocks.sendNotification.mockResolvedValue({ statusCode: 201 })
  mocks.sessionMetadata.mockResolvedValue(null)
  mocks.appSettings.mockReturnValue({})
  // The relay answers one result per push, in order.
  mocks.fetch.mockImplementation(async (_url: string, init: { body: string }) => {
    const { pushes } = JSON.parse(init.body) as { pushes: Array<{ deviceToken: string }> }
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: pushes.map((push) => ({ deviceToken: push.deviceToken, status: 200 })) }),
    }
  })
  await testDb.insert(schema.pushVapidKeys)
    .values({ id: 1, publicKey: 'vapid-pub', privateKey: 'vapid-priv', createdAt: EPOCH })
    .run()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await handle.close()
})

describe('recipient matrix, with sign-in', () => {
  beforeEach(async () => {
    // Members of the agent.
    await addMember('owner', {}, 'owner')

    await addMember('member')
    await addSubscription('member-2', 'member') // a second browser
    await addDevice('member-2', 'member', { family: 'family-member-2' }) // a second phone

    await addMember('viewer', {}, 'viewer')

    // People who must hear nothing.
    await addUser('admin', { role: 'admin' }) // an admin with no row on the agent
    await addSubscription('admin', 'admin')
    await addDevice('admin', 'admin', { family: 'family-admin' })

    await addUser('outsider')
    await addAccess('outsider', OTHER_AGENT, 'owner')
    await addSubscription('outsider', 'outsider')
    await addDevice('outsider', 'outsider', { family: 'family-outsider' })

    // Invited, not joined: on the agent's list, but nobody to notify. The
    // device rows cannot exist in practice; they stand for a status that lags.
    await addMember('invited', { status: 'invited' })

    // Rows with no owner, or whose owner is gone.
    await addSubscription('ownerless', null)
    await addDevice('ownerless', null)
    await addSubscription('deleted-user', 'deleted-user')
    await addDevice('deleted-user', 'deleted-user')

    // A member whose phone's pairing expired.
    await addUser('expired')
    await addAccess('expired')
    await addDevice('expired', 'expired', { family: 'family-expired', expiresAt: new Date(1) })

    // Members with preferences.
    await addMember('muted-complete')
    await setNotificationSettings('muted-complete', { enabled: true, sessionComplete: false })
    await addMember('all-off')
    await setNotificationSettings('all-off', { enabled: false })
    await addMember('corrupt-settings')
    await testDb.insert(schema.userSettings)
      .values({ userId: 'corrupt-settings', settings: '{not json', updatedAt: EPOCH })
      .run()

    // Banned: sign-in is refused, but the push channels have never looked at it.
    await addMember('banned', { banned: true })
  })

  const EVERY_MEMBER_TOKEN = [
    'owner', 'member', 'member-2', 'viewer', 'muted-complete', 'all-off', 'corrupt-settings', 'banned',
  ]

  it('web push reaches every device of every active member who has the type on', async () => {
    await deliver({ type: 'session_complete' })

    expect(webPushed()).toEqual(
      ['owner', 'member', 'member-2', 'viewer', 'corrupt-settings', 'banned'].sort(),
    )
  })

  it('web push follows the type: a member who muted completions still hears a waiting session', async () => {
    await deliver({ type: 'session_waiting' })

    expect(webPushed()).toEqual(
      ['owner', 'member', 'member-2', 'viewer', 'muted-complete', 'corrupt-settings', 'banned'].sort(),
    )
  })

  it('APNs reaches every live device of every active member, silently when no phone started the session', async () => {
    await deliver({ type: 'session_complete' })

    expect(apnsPushed()).toEqual(
      Object.fromEntries(EVERY_MEMBER_TOKEN.map((token) => [token, ['background']])),
    )
  })

  it('APNs alerts only the phone that started the session', async () => {
    mocks.sessionMetadata.mockResolvedValue({ createdByDeviceId: 'family-member-2' })

    await deliver({ type: 'session_complete' })

    expect(apnsPushed()).toEqual({
      ...Object.fromEntries(EVERY_MEMBER_TOKEN.map((token) => [token, ['background']])),
      'member-2': ['alert', 'background'],
    })
  })

  it('APNs keeps the starting phone silent when its owner turned the type off', async () => {
    mocks.sessionMetadata.mockResolvedValue({ createdByDeviceId: 'family-muted-complete' })
    await deliver({ type: 'session_complete' })
    expect(apnsPushed()['muted-complete']).toEqual(['background'])

    mocks.fetch.mockClear()
    await deliver({ type: 'session_waiting' })
    expect(apnsPushed()['muted-complete']).toEqual(['alert', 'background'])

    mocks.fetch.mockClear()
    mocks.sessionMetadata.mockResolvedValue({ createdByDeviceId: 'family-all-off' })
    await deliver({ type: 'session_waiting' })
    expect(apnsPushed()['all-off']).toEqual(['background'])
  })

  it('a phone outside the agent cannot claim the alert', async () => {
    mocks.sessionMetadata.mockResolvedValue({ createdByDeviceId: 'family-outsider' })

    await deliver({ type: 'session_complete' })

    expect(apnsPushed()).toEqual(
      Object.fromEntries(EVERY_MEMBER_TOKEN.map((token) => [token, ['background']])),
    )
  })

  it('a mention goes to every device of the person tagged, and to nobody else', async () => {
    // Someone else's phone started the session; the mention is not theirs.
    mocks.sessionMetadata.mockResolvedValue({ createdByDeviceId: 'family-owner' })

    await deliver({ type: 'session_mention', recipientUserId: 'member' })

    expect(webPushed()).toEqual(['member', 'member-2'])
    expect(apnsPushed()).toEqual({
      member: ['alert', 'background'],
      'member-2': ['alert', 'background'],
    })
  })

  it('a mention of someone with notifications off sends no banner anywhere', async () => {
    await deliver({ type: 'session_mention', recipientUserId: 'all-off' })

    expect(webPushed()).toEqual([])
    expect(apnsPushed()).toEqual({ 'all-off': ['background'] })
  })

  it.each(['outsider', 'admin', 'invited', 'deleted-user', 'nobody'])(
    'a mention of %s, who is not an active member, is pushed to no one',
    async (recipientUserId) => {
      await deliver({ type: 'session_mention', recipientUserId })

      expect(mocks.sendNotification).not.toHaveBeenCalled()
      expect(mocks.fetch).not.toHaveBeenCalled()
    },
  )

  it('another agent’s notification reaches only that agent’s members', async () => {
    await deliver({ agentSlug: OTHER_AGENT })

    expect(webPushed()).toEqual(['outsider'])
    expect(apnsPushed()).toEqual({ outsider: ['background'] })
  })

  it('an agent nobody is a member of is pushed to no one', async () => {
    await deliver({ agentSlug: 'agent-unshared' })

    expect(mocks.sendNotification).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('prunes a subscription the push service says is gone, and still sends to the rest', async () => {
    mocks.sendNotification.mockImplementation(async (target: unknown) => {
      if ((target as { endpoint: string }).endpoint.endsWith('/member')) {
        throw Object.assign(new Error('Gone'), { statusCode: 410 })
      }
      return { statusCode: 201 }
    })

    await webPush.deliver(makeEvent())

    expect(webPushed()).toContain('member-2')
    const left = (await testDb.select({ id: schema.pushSubscriptions.id }).from(schema.pushSubscriptions).all())
      .map((row) => row.id)
    expect(left).not.toContain('sub-member')
    expect(left).toContain('sub-member-2')
    // Rows that were never sent to are not touched.
    expect(left).toContain('sub-outsider')
    expect(left).toContain('sub-ownerless')
  })

  it('prunes a device whose token is dead, and keeps the rest', async () => {
    mocks.fetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const { pushes } = JSON.parse(init.body) as { pushes: Array<{ deviceToken: string }> }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: pushes.map((push) => push.deviceToken === 'member'
            ? { deviceToken: push.deviceToken, status: 410, reason: 'Unregistered' }
            : { deviceToken: push.deviceToken, status: 200 }),
        }),
      }
    })

    await apns.deliver(makeEvent())

    const left = (await testDb.select({ id: schema.apnsDevices.id }).from(schema.apnsDevices).all())
      .map((row) => row.id)
    expect(left).not.toContain('dev-member')
    expect(left).toContain('dev-member-2')
    expect(left).toContain('dev-outsider')
  })
})

describe('recipient matrix, local mode (no users)', () => {
  beforeEach(async () => {
    authMode = false
    await addSubscription('laptop', null)
    await addSubscription('phone', null)
    // Left over from a time this database ran with sign-in.
    await addSubscription('stale-owner', 'someone-long-gone')
    await addDevice('iphone', null)
    await addDevice('stale-iphone', 'someone-long-gone')
  })

  it('pushes to every stored device', async () => {
    await deliver({ type: 'session_complete' })

    expect(webPushed()).toEqual(['laptop', 'phone', 'stale-owner'])
    expect(apnsPushed()).toEqual({ iphone: ['background'], 'stale-iphone': ['background'] })
  })

  it('the local settings govern every device, whatever a stale owner once chose', async () => {
    await setNotificationSettings('local', { enabled: true, sessionComplete: false })
    await setNotificationSettings('someone-long-gone', { enabled: true, sessionComplete: true })

    await deliver({ type: 'session_complete' })
    expect(webPushed()).toEqual([])
    // Silent pushes keep the widget fresh regardless of preferences.
    expect(apnsPushed()).toEqual({ iphone: ['background'], 'stale-iphone': ['background'] })

    await deliver({ type: 'session_waiting' })
    expect(webPushed()).toEqual(['laptop', 'phone', 'stale-owner'])
  })

  it('a first read seeds the local settings from the app settings', async () => {
    mocks.appSettings.mockReturnValue({ app: { notifications: { enabled: false } } })

    await deliver({ type: 'session_complete' })

    expect(webPushed()).toEqual([])
  })
})

describe('statements per notification', () => {
  /** Run `work` and count the statements it issues against the database. */
  async function countStatements(work: () => Promise<void>): Promise<number> {
    const spies = (['select', 'insert', 'update', 'delete'] as const).map((method) => vi.spyOn(testDb, method))
    await work()
    const total = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)
    for (const spy of spies) spy.mockRestore()
    return total
  }

  /** `members` members of the agent with two browsers and two phones each, and as many people outside it. */
  async function seedWorkspace(members: number): Promise<void> {
    for (let i = 0; i < members; i++) {
      const id = `member-${i}`
      await addMember(id)
      await addSubscription(`${id}-b`, id)
      await addDevice(`${id}-b`, id, { family: `family-${id}-b` })
      // Half have saved preferences; the rest have no settings row yet.
      if (i % 2 === 0) await setNotificationSettings(id, { enabled: true })

      const outsider = `outsider-${i}`
      await addUser(outsider)
      await addAccess(outsider, OTHER_AGENT)
      await addSubscription(outsider, outsider)
      await addDevice(outsider, outsider, { family: `family-${outsider}` })
    }
  }

  async function measure(members: number, channel: 'web' | 'apns', event: NotificationEvent): Promise<number> {
    await handle.close()
    handle = await createTestDatabase()
    testDb = handle.db
    await testDb.insert(schema.pushVapidKeys)
      .values({ id: 1, publicKey: 'vapid-pub', privateKey: 'vapid-priv', createdAt: EPOCH })
      .run()
    await seedWorkspace(members)
    mocks.sendNotification.mockClear()
    mocks.fetch.mockClear()
    const statements = await countStatements(() => (channel === 'web' ? webPush : apns).deliver(event))
    // The count is only worth pinning if the fan-out really happened.
    if (channel === 'web') expect(mocks.sendNotification).toHaveBeenCalledTimes(members * 2)
    else expect(Object.keys(apnsPushed())).toHaveLength(members * 2)
    return statements
  }

  it('web push: three statements, for one member or twenty', async () => {
    const one = await measure(1, 'web', makeEvent())
    const twenty = await measure(20, 'web', makeEvent())

    // Eligible subscriptions, VAPID keys, their owners' settings.
    expect(one).toBe(3)
    expect(twenty).toBe(3)
  })

  it('APNs: one statement when no phone started the session, two when one did', async () => {
    const silentOne = await measure(1, 'apns', makeEvent())
    const silentTwenty = await measure(20, 'apns', makeEvent())
    // Eligible devices only: nobody's preferences are needed for a silent push.
    expect(silentOne).toBe(1)
    expect(silentTwenty).toBe(1)

    mocks.sessionMetadata.mockResolvedValue({ createdByDeviceId: 'family-member-0' })
    const originOne = await measure(1, 'apns', makeEvent())
    const originTwenty = await measure(20, 'apns', makeEvent())
    // Plus the settings of the one owner whose phone may show the alert.
    expect(originOne).toBe(2)
    expect(originTwenty).toBe(2)
  })

  it('local mode: the local settings are read once, not once per device', async () => {
    authMode = false
    for (let i = 0; i < 12; i++) await addSubscription(`device-${i}`, null)
    await setNotificationSettings('local', { enabled: true })

    const statements = await countStatements(() => webPush.deliver(makeEvent()))

    expect(mocks.sendNotification).toHaveBeenCalledTimes(12)
    // Subscriptions, VAPID keys, the local settings.
    expect(statements).toBe(3)
  })
})

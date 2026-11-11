import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appState,
  closeAppState,
  createLocalAppState,
  initializeAppState,
  LocalAppStateBackend,
  type AppState,
} from '@shared/lib/app-state'
import { backgroundSettled } from '@shared/lib/background'
import {
  agentFeedChannel,
  GlobalFeed,
  globalFeed,
  tenantFeedChannel,
  userFeedChannel,
  type GlobalFeedEvent,
} from './global-feed'

/** One event from each family the feed carries, with the channel it belongs on in auth mode. */
const FAMILIES: Array<{ event: GlobalFeedEvent; on: 'tenant' | 'agent' | 'user' }> = [
  { event: { type: 'agent_updated', agentSlug: 'a' }, on: 'agent' },
  { event: { type: 'agent_status_changed', agentSlug: 'a', status: 'running' }, on: 'agent' },
  { event: { type: 'container_health_changed', agentSlug: 'a' }, on: 'agent' },
  { event: { type: 'mount_health_warning', agentSlug: 'a', notMounted: [] }, on: 'agent' },
  { event: { type: 'browser_active', agentSlug: 'a', active: false }, on: 'agent' },
  { event: { type: 'session_active', agentSlug: 'a', sessionId: 's', isActive: true }, on: 'agent' },
  { event: { type: 'session_idle', agentSlug: 'a', sessionId: 's', isActive: false }, on: 'agent' },
  { event: { type: 'session_updated', agentSlug: 'a', sessionId: 's' }, on: 'agent' },
  { event: { type: 'user_request_created', agentSlug: 'a', request: { id: 'r' } }, on: 'agent' },
  { event: { type: 'user_request_resolved', agentSlug: 'a', requestId: 'r' }, on: 'agent' },
  { event: { type: 'background_task_started', agentSlug: 'a', sessionId: 's', taskId: 't' }, on: 'agent' },
  { event: { type: 'os_notification', agentSlug: 'a', notificationId: 'n', title: 'Session complete' }, on: 'agent' },
  { event: { type: 'scheduled_task_created', agentSlug: 'a', taskId: 't' }, on: 'agent' },
  { event: { type: 'webhook_trigger_updated', agentSlug: 'a', triggerId: 't' }, on: 'agent' },
  { event: { type: 'dashboard_status_changed', agentSlug: 'a', dashboardSlug: 'd', status: 'running' }, on: 'agent' },
  { event: { type: 'widget_snapshot_ready', agentSlug: 'a', widgetSlug: 'w' }, on: 'agent' },
  { event: { type: 'os_notification', agentSlug: 'a', recipientUserId: 'u', title: 'Dana mentioned you' }, on: 'user' },
  { event: { type: 'session_mention_withdrawn', agentSlug: 'a', recipientUserId: 'u', sessionId: 's' }, on: 'user' },
  { event: { type: 'runtime_readiness_changed', readiness: 'ready' }, on: 'tenant' },
  { event: { type: 'system_alert', level: 'warning', title: 't' }, on: 'tenant' },
  { event: { type: 'webhook_relay_changed', status: 'connected' }, on: 'tenant' },
  { event: { type: 'volume_attention_changed' }, on: 'tenant' },
  { event: { type: 'platform_notifications_changed' }, on: 'tenant' },
]

/** Follows the tenant's, agent `a`'s and user `u`'s channels, each into its own list. */
async function followAll(feed: GlobalFeed = globalFeed) {
  const received = { tenant: [] as GlobalFeedEvent[], agent: [] as GlobalFeedEvent[], user: [] as GlobalFeedEvent[] }
  await feed.subscribe([tenantFeedChannel()], (event) => received.tenant.push(event))
  await feed.subscribe([agentFeedChannel('a')], (event) => received.agent.push(event))
  await feed.subscribe([userFeedChannel('u')], (event) => received.user.push(event))
  return received
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GlobalFeed channels', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'true')
  })

  it('carries each event family on its audience\'s channel only', async () => {
    const received = await followAll()

    for (const { event } of FAMILIES) globalFeed.publish(event)
    await backgroundSettled()

    for (const on of ['tenant', 'agent', 'user'] as const) {
      expect(received[on]).toEqual(FAMILIES.filter((family) => family.on === on).map((family) => family.event))
    }
  })

  it('carries an agent\'s events to its channel and no other agent\'s', async () => {
    const other: GlobalFeedEvent[] = []
    await globalFeed.subscribe([agentFeedChannel('b')], (event) => other.push(event))
    const received = await followAll()

    globalFeed.publish({ type: 'session_active', agentSlug: 'a', sessionId: 's' })
    globalFeed.publish({ type: 'session_active', agentSlug: 'b', sessionId: 't' })
    await backgroundSettled()

    expect(received.agent.map((event) => event.sessionId)).toEqual(['s'])
    expect(other.map((event) => event.sessionId)).toEqual(['t'])
  })

  it('sends to users on their own channels, whatever agent the event names, without changing it', async () => {
    const received = await followAll()
    const v: GlobalFeedEvent[] = []
    await globalFeed.subscribe([userFeedChannel('v')], (event) => v.push(event))

    globalFeed.publishToUsers(['u', 'v', 'u'], { type: 'agent_access_revoked', agentSlug: 'a' })
    await backgroundSettled()

    expect(received.user).toEqual([{ type: 'agent_access_revoked', agentSlug: 'a' }])
    expect(v).toEqual([{ type: 'agent_access_revoked', agentSlug: 'a' }])
    // Not on the agent's channel: a user who just lost the agent no longer follows it.
    expect(received.agent).toEqual([])
    expect(received.tenant).toEqual([])
  })

  it('carries everything on the tenant\'s channel in local mode, where there is one principal', async () => {
    vi.stubEnv('AUTH_MODE', 'false')
    const received = await followAll()

    for (const { event } of FAMILIES) globalFeed.publish(event)
    globalFeed.publishToUsers(['u'], { type: 'agent_created', agentSlug: 'a' })
    await backgroundSettled()

    expect(received.tenant).toEqual([...FAMILIES.map((family) => family.event), { type: 'agent_created', agentSlug: 'a' }])
    expect(received.agent).toEqual([])
    expect(received.user).toEqual([])
  })
})

describe('GlobalFeed delivery', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'true')
  })

  it('returns from publish before any listener runs, and does not wait for a listener\'s work', async () => {
    const seen: string[] = []
    const unfinished: Array<() => void> = []
    await globalFeed.subscribe([agentFeedChannel('a')], async (event) => {
      seen.push(event.type)
      await new Promise<void>((resolve) => unfinished.push(resolve))
      seen.push(`${event.type}:done`)
    })

    globalFeed.publish({ type: 'session_idle', agentSlug: 'a' })
    expect(seen).toEqual([])

    await vi.waitFor(() => expect(seen).toEqual(['session_idle']))
    globalFeed.publish({ type: 'session_active', agentSlug: 'a' })
    await vi.waitFor(() => expect(seen).toEqual(['session_idle', 'session_active']))

    for (const finish of unfinished) finish()
    await backgroundSettled()
    expect(seen).toEqual(['session_idle', 'session_active', 'session_idle:done', 'session_active:done'])
  })

  it('hands each listener its own copy of the event', async () => {
    const copies: GlobalFeedEvent[] = []
    for (let i = 0; i < 2; i++) await globalFeed.subscribe([agentFeedChannel('a')], (event) => copies.push(event))
    const published: GlobalFeedEvent = { type: 'widget_snapshot_ready', agentSlug: 'a', meta: { n: 1 } }

    globalFeed.publish(published)
    published.meta = 'changed after publish'
    await backgroundSettled()

    expect(copies).toEqual([
      { type: 'widget_snapshot_ready', agentSlug: 'a', meta: { n: 1 } },
      { type: 'widget_snapshot_ready', agentSlug: 'a', meta: { n: 1 } },
    ])
    expect(copies[0]).not.toBe(copies[1])
  })

  it('reaches a listener in this process from a feed in another process', async () => {
    // Two clients of one backend are two processes of one tenant.
    await closeAppState()
    const backend = new LocalAppStateBackend()
    await initializeAppState(createLocalAppState({ backend }))
    const otherProcess: AppState = createLocalAppState({ backend })
    const otherFeed = new GlobalFeed(() => otherProcess)
    const received = await followAll()

    otherFeed.publish({ type: 'session_active', agentSlug: 'a', sessionId: 'there' })
    otherFeed.publishToUsers(['u'], { type: 'agent_members_changed', agentSlug: 'a' })
    await backgroundSettled()

    expect(received.agent).toEqual([{ type: 'session_active', agentSlug: 'a', sessionId: 'there' }])
    expect(received.user).toEqual([{ type: 'agent_members_changed', agentSlug: 'a' }])
  })

  it('stops delivering once a subscription is unsubscribed or its signal aborts', async () => {
    const byUnsubscribe = vi.fn()
    const byAbort = vi.fn()
    const subscription = await globalFeed.subscribe([agentFeedChannel('a')], byUnsubscribe)
    const controller = new AbortController()
    await globalFeed.subscribe([agentFeedChannel('a')], byAbort, { signal: controller.signal })

    globalFeed.publish({ type: 'before', agentSlug: 'a' })
    await backgroundSettled()
    await subscription.unsubscribe()
    controller.abort()
    globalFeed.publish({ type: 'after', agentSlug: 'a' })
    await backgroundSettled()

    expect(byUnsubscribe.mock.calls.map(([event]) => event.type)).toEqual(['before'])
    expect(byAbort.mock.calls.map(([event]) => event.type)).toEqual(['before'])
  })

  it('leaves no listener behind when the signal aborts while the subscription is still being set up', async () => {
    const listener = vi.fn()
    const controller = new AbortController()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const state = appState()
    const subscribe = state.subscribe.bind(state)
    vi.spyOn(state, 'subscribe').mockImplementation(async (...args) => {
      await held
      return subscribe(...args)
    })

    const subscribing = globalFeed.subscribe([agentFeedChannel('a')], listener, { signal: controller.signal })
    controller.abort()
    release()
    await subscribing
    globalFeed.publish({ type: 'session_active', agentSlug: 'a' })
    await backgroundSettled()

    expect(listener).not.toHaveBeenCalled()
  })

  it('drops an event published before AppState exists, where nothing can be subscribed', async () => {
    await closeAppState()

    expect(() => globalFeed.publish({ type: 'session_active', agentSlug: 'a' })).not.toThrow()
    await backgroundSettled()
    await expect(globalFeed.subscribe([tenantFeedChannel()], vi.fn())).rejects.toThrow(/AppState/)
  })
})

describe('GlobalFeed published hooks', () => {
  it('runs a hook inside publish, in the publishing process, whether or not anything is delivered', () => {
    // No AppState: nothing can be delivered.
    const feed = new GlobalFeed(() => null)
    const seen: string[] = []
    const stop = feed.onPublished((event) => seen.push(event.type))

    feed.publish({ type: 'session_idle', agentSlug: 'agent-1' })
    expect(seen).toEqual(['session_idle'])

    stop()
    feed.publish({ type: 'session_active', agentSlug: 'agent-1' })
    expect(seen).toEqual(['session_idle'])
  })

  it('still publishes, and runs the other hooks, when a hook throws', () => {
    const feed = new GlobalFeed(() => null)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    feed.onPublished(() => {
      throw new Error('a hook failed')
    })
    feed.onPublished((event) => seen.push(event.type))

    expect(() => feed.publish({ type: 'session_idle', agentSlug: 'agent-1' })).not.toThrow()
    expect(seen).toEqual(['session_idle'])
    errors.mockRestore()
  })
})


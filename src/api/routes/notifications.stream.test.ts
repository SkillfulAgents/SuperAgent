import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from 'hono'
import {
  appState,
  closeAppState,
  createLocalAppState,
  initializeAppState,
  LocalAppStateBackend,
  type Channel,
} from '@shared/lib/app-state'
import { backgroundSettled } from '@shared/lib/background'
import * as collaborationEvents from '@shared/lib/services/collaboration-events'
import {
  agentFeedChannel,
  GlobalFeed,
  globalFeed,
  tenantFeedChannel,
  userFeedChannel,
  type GlobalFeedEvent,
} from '@shared/lib/notifications/global-feed'

/**
 * The notifications SSE stream over a real HTTP listener and the real global
 * feed, through this process's AppState.
 *
 * `app.request()` never aborts: only a real socket teardown makes
 * `@hono/node-server` fire the stream's abort signal, and that signal is the
 * ONLY disconnect notification the handler ever gets — Hono's StreamingApi
 * swallows write errors, so a failed ping can't surface a disconnect. These
 * tests connect through a real socket, kill it, and assert the handler
 * releases what it holds per connection: its feed subscriptions and the
 * 30-second keep-alive interval.
 */

const { abortBeforeHandler, authMode, authGate, streamCallbacks, stallWrites } = vi.hoisted(() => ({
  // When true, the streamSSE wrapper below aborts the stream BEFORE the
  // route's handler body runs — deterministically reproducing a client that
  // disconnected during handler setup, i.e. before onAbort is registered.
  abortBeforeHandler: { value: false },
  authMode: { value: false },
  // When set, the auth middleware waits on it, holding the request before the
  // route runs; `signals` records each held request's AbortSignal.
  authGate: { value: null as Promise<void> | null, signals: [] as AbortSignal[] },
  // How many stream callbacks have returned.
  streamCallbacks: { finished: 0 },
  // When set, the client's socket takes this many frames and then none: every
  // later write waits until the stream is aborted.
  stallWrites: { after: null as number | null },
}))

// Transparent pass-through around streamSSE, except it can pre-abort the
// stream to exercise the abort-raced-with-setup path, and stall its writes to
// stand in for a client that stopped reading.
vi.mock('hono/streaming', async (importOriginal) => {
  const real = await importOriginal<typeof import('hono/streaming')>()
  return {
    ...real,
    streamSSE: (
      c: Parameters<typeof real.streamSSE>[0],
      cb: Parameters<typeof real.streamSSE>[1],
    ) =>
      real.streamSSE(c, async (stream) => {
        if (abortBeforeHandler.value) stream.abort()
        const takes = stallWrites.after
        if (takes !== null) {
          const write = stream.writeSSE.bind(stream)
          let taken = 0
          stream.writeSSE = async (message) => {
            if (taken++ < takes) return write(message)
            if (!stream.aborted) await new Promise<void>((resolve) => stream.onAbort(resolve))
          }
        }
        await cb(stream)
        streamCallbacks.finished++
      }),
  }
})

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => authMode.value }))

// Auth middleware: no-op in tests
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (c: Context, next: () => Promise<void>) => {
    c.set('user', { id: c.req.header('x-test-user') })
    if (authGate.value) {
      authGate.signals.push(c.req.raw.signal)
      await authGate.value
    }
    return next()
  },
  HasNotificationAccess: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('@shared/lib/services/notification-read-state', () => ({
  notificationReadAgentSlugs: vi.fn(), confirmNotificationRead: vi.fn(),
}))

vi.mock('@shared/lib/services/notification-service', () => ({
  listNotifications: vi.fn(),
  countNotifications: vi.fn(),
  getUnreadCount: vi.fn(),
  markAsRead: vi.fn(),
  markAllAsRead: vi.fn(),
  markSessionNotificationsRead: vi.fn(),
  deleteNotification: vi.fn(),
  getAccessibleAgentSlugs: vi.fn().mockResolvedValue([]),
  getUnreadMentionCount: vi.fn(),
}))

import notificationsRouter from './notifications'
import { getAccessibleAgentSlugs } from '@shared/lib/services/notification-service'
import { armAbortSignal } from '../middleware/arm-abort-signal'

// Track the handler's keep-alive intervals by their signature (30s delay) so
// we can prove each one created is also cleared.
const KEEP_ALIVE_MS = 30000
const createdKeepAlives = new Set<unknown>()
const clearedKeepAlives = new Set<unknown>()
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval

let server: ReturnType<typeof serve>
let port: number

beforeAll(async () => {
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((
    handler: () => void,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const id = realSetInterval(handler, timeout, ...args)
    if (timeout === KEEP_ALIVE_MS) createdKeepAlives.add(id)
    return id
  }) as typeof setInterval)
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: unknown) => {
    if (createdKeepAlives.has(id)) clearedKeepAlives.add(id)
    return realClearInterval(id as Parameters<typeof clearInterval>[0])
  }) as typeof clearInterval)

  const app = new Hono()
  // As in the real app: armed ahead of every middleware that awaits.
  app.use('*', armAbortSignal)
  app.route('/api/notifications', notificationsRouter)
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      port = info.port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  vi.restoreAllMocks()
})

/**
 * Every subscription this process's AppState was asked for, and every event
 * its listener really got: a listener the route left behind still counts, so
 * a leak shows up as a call after the stream is gone.
 */
interface Followed {
  paths: string[]
  ended: boolean
  calls: number
}
let followed: Followed[] = []
let subscribeGate: Promise<void> | null = null

/** Wraps the installed AppState's subscribe to record what is followed (call again after installing another). */
function trackSubscriptions(): void {
  const state = appState()
  const subscribe = state.subscribe.bind(state)
  vi.spyOn(state, 'subscribe').mockImplementation(async (channels, listener, options) => {
    const entry: Followed = { paths: channels.map((channel) => channel.path), ended: false, calls: 0 }
    followed.push(entry)
    if (subscribeGate) await subscribeGate
    const end = () => {
      entry.ended = true
    }
    const subscription = await subscribe(
      channels,
      (event, channel) => {
        entry.calls++
        return listener(event, channel)
      },
      options,
    )
    if (options?.signal?.aborted) end()
    options?.signal?.addEventListener('abort', end, { once: true })
    return {
      unsubscribe: async () => {
        end()
        await subscription.unsubscribe()
      },
    }
  })
}

/** Subscriptions the route holds now. */
const live = () => followed.filter((entry) => !entry.ended)
/** Whether a live subscription follows this channel. */
const follows = (channel: Channel<GlobalFeedEvent>) => live().some((entry) => entry.paths.includes(channel.path))

/** Publish to every channel ever followed and check no listener, ended or not, hears it. */
async function expectNothingListening(): Promise<void> {
  const before = followed.map((entry) => entry.calls)
  const paths = new Set(followed.flatMap((entry) => entry.paths))
  const channels = [tenantFeedChannel(), ...['a', 'mine', 'theirs', 'shared', 'fresh'].map(agentFeedChannel), ...['local', 'member', 'u'].map(userFeedChannel)]
  for (const channel of channels) if (paths.has(channel.path)) await appState().publish(channel, { type: 'probe' })
  await backgroundSettled()
  expect(followed.map((entry) => entry.calls)).toEqual(before)
}

beforeEach(() => {
  followed = []
  subscribeGate = null
  trackSubscriptions()
})

afterEach(() => {
  vi.mocked(getAccessibleAgentSlugs).mockReset().mockResolvedValue([])
  abortBeforeHandler.value = false
  authMode.value = false
  authGate.value = null
  authGate.signals = []
  stallWrites.after = null
})

/** Poll until `predicate` holds or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

/** Open the SSE endpoint over a real socket; resolves once bytes can be read. */
function connectSSE(userId = 'local'): Promise<{
  received: () => string
  destroy: () => void
  closed: () => boolean
  waitForData: (needle: string, timeoutMs?: number) => Promise<boolean>
}> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/notifications/stream', headers: { Accept: 'text/event-stream', 'x-test-user': userId } },
      (res) => {
        let buffer = ''
        let closed = false
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
        })
        res.on('error', () => {})
        res.on('close', () => {
          closed = true
        })
        resolve({
          received: () => buffer,
          destroy: () => req.destroy(),
          closed: () => closed,
          waitForData: (needle, timeoutMs) => waitFor(() => buffer.includes(needle), timeoutMs),
        })
      },
    )
    req.on('error', reject)
  })
}

/** The `data:` payloads the client has received so far, parsed, pings excluded. */
const payloads = (client: { received: () => string }) =>
  client
    .received()
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as GlobalFeedEvent)
    .filter((event) => event.type !== 'ping')

/** A load the test releases by hand, to hold the gate mid-load. */
function deferredLoad() {
  let resolve!: (slugs: string[]) => void
  const promise = new Promise<string[]>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('GET /api/notifications/stream teardown', () => {
  it('registers a client and keep-alive on connect, and releases both on disconnect', async () => {
    const before = createdKeepAlives.size
    const client = await connectSSE()

    expect(await client.waitForData('"type":"connected"')).toBe(true)
    expect(live()).toHaveLength(1)
    expect(createdKeepAlives.size).toBe(before + 1)

    client.destroy()

    expect(await waitFor(() => live().length === 0)).toBe(true)
    expect(await waitFor(() => clearedKeepAlives.size === createdKeepAlives.size)).toBe(true)
    await expectNothingListening()
  })

  it('still delivers notifications while connected (no premature teardown)', async () => {
    const client = await connectSSE()
    expect(await client.waitForData('"type":"connected"')).toBe(true)

    globalFeed.publish({ type: 'os_notification', title: 'hello-still-connected' })

    expect(await client.waitForData('hello-still-connected')).toBe(true)
    expect(live()).toHaveLength(1)

    client.destroy()
    expect(await waitFor(() => live().length === 0)).toBe(true)
  })

  it('cleans up when the abort fires before the handler waits on it', async () => {
    abortBeforeHandler.value = true

    for (let i = 0; i < 3; i++) {
      const created = createdKeepAlives.size
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/notifications/stream' }, (res) => {
          res.resume()
          res.on('close', () => resolve())
        })
        req.on('error', reject)
      })

      // The handler ran (it created its keep-alive) against a stream that was
      // already aborted before onAbort could be registered — the `aborted`
      // flag check is the only thing that lets the wait settle here.
      expect(await waitFor(() => createdKeepAlives.size === created + 1)).toBe(true)
      expect(await waitFor(() => live().length === 0)).toBe(true)
      expect(await waitFor(() => clearedKeepAlives.size === createdKeepAlives.size)).toBe(true)
    }
    await expectNothingListening()
  })

  it('sets nothing up for a client that left before the stream started', async () => {
    let release!: () => void
    authGate.value = new Promise<void>((resolve) => {
      release = resolve
    })
    const created = createdKeepAlives.size
    const finished = streamCallbacks.finished

    const req = http.get({ host: '127.0.0.1', port, path: '/api/notifications/stream' }, () => {})
    req.on('error', () => {})
    expect(await waitFor(() => authGate.signals.length === 1)).toBe(true)
    // The client leaves while the request is still in the middleware, before
    // streamSSE has a body for @hono/node-server to pipe: hono's stream never
    // hears of it, only the request signal does.
    req.destroy()
    expect(await waitFor(() => authGate.signals[0].aborted)).toBe(true)
    release()

    expect(await waitFor(() => streamCallbacks.finished === finished + 1)).toBe(true)
    expect(followed).toHaveLength(0)
    expect(createdKeepAlives.size).toBe(created)
  })

  it('leaves no residue after repeated connect/disconnect cycles', async () => {
    for (let i = 0; i < 5; i++) {
      const client = await connectSSE()
      expect(await client.waitForData('"type":"connected"')).toBe(true)
      expect(live()).toHaveLength(1)
      client.destroy()
      expect(await waitFor(() => live().length === 0)).toBe(true)
    }

    expect(await waitFor(() => clearedKeepAlives.size === createdKeepAlives.size)).toBe(true)
    await expectNothingListening()
  })
})

describe('disposal while the stream is still being set up', () => {
  it('leaves no listener behind when the client leaves while subscribing is in progress', async () => {
    let release!: () => void
    subscribeGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const finished = streamCallbacks.finished
    const client = await connectSSE()
    expect(await waitFor(() => followed.length === 1)).toBe(true)

    client.destroy()
    release()

    expect(await waitFor(() => streamCallbacks.finished === finished + 1)).toBe(true)
    expect(live()).toHaveLength(0)
    expect(client.received()).not.toContain('"type":"connected"')
    await expectNothingListening()
  })

  it('follows no agent a first load finds after the client has gone', async () => {
    authMode.value = true
    const firstLoad = deferredLoad()
    vi.mocked(getAccessibleAgentSlugs).mockReturnValueOnce(firstLoad.promise)
    const finished = streamCallbacks.finished
    const client = await connectSSE('member')
    expect(await waitFor(() => vi.mocked(getAccessibleAgentSlugs).mock.calls.length === 1)).toBe(true)

    client.destroy()
    expect(await waitFor(() => live().length === 0)).toBe(true)
    firstLoad.resolve(['a'])

    expect(await waitFor(() => streamCallbacks.finished === finished + 1)).toBe(true)
    await backgroundSettled()
    expect(live()).toHaveLength(0)
    await expectNothingListening()
  })
})

describe('bounded delivery', () => {
  it('ends the stream of a client that stopped reading instead of queueing without limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The socket takes the greeting and one event, then nothing.
    stallWrites.after = 2
    const client = await connectSSE()
    expect(await client.waitForData('"type":"connected"')).toBe(true)

    for (let n = 0; n < 1_100; n++) globalFeed.publish({ type: 'runtime_readiness_changed', n })

    expect(await waitFor(() => client.closed())).toBe(true)
    expect(warn).toHaveBeenCalledWith('[Notifications] A stream client fell too far behind; closing its stream')
    expect(await waitFor(() => live().length === 0)).toBe(true)
    warn.mockRestore()
  })
})

describe('collaboration hints over the existing stream', () => {
  it('delivers only to the targeted users and releases subscriptions on socket close', async () => {
    authMode.value = true
    const clients = await Promise.all(['owner', 'removed', 'unrelated'].map((userId) => connectSSE(userId)))
    try {
      for (const client of clients) expect(await client.waitForData('"type":"connected"')).toBe(true)
      collaborationEvents.publishCollaborationEvent(['owner'], { type: 'agent_members_changed', agentSlug: 'private-agent' })
      collaborationEvents.publishCollaborationEvent(['removed'], { type: 'agent_access_revoked', agentSlug: 'private-agent' })
      collaborationEvents.publishCollaborationEvent(['unrelated'], { type: 'agent_members_changed', agentSlug: 'unrelated-agent' })
      expect(await clients[0].waitForData('agent_members_changed')).toBe(true)
      expect(await clients[1].waitForData('agent_access_revoked')).toBe(true)
      expect(await clients[2].waitForData('unrelated-agent')).toBe(true)
      expect(clients[2].received()).not.toContain('private-agent')
      expect(clients[0].received()).not.toContain('agent_access_revoked')
    } finally {
      clients.forEach((client) => client.destroy())
      expect(await waitFor(() => live().length === 0)).toBe(true)
    }
  })
})

describe('auth-mode access over the global feed', () => {
  it('follows only the accessible agents, and holds what arrives during the first load', async () => {
    authMode.value = true
    const firstLoad = deferredLoad()
    vi.mocked(getAccessibleAgentSlugs).mockReturnValueOnce(firstLoad.promise)
    const client = await connectSSE('member')
    expect(await waitFor(() => follows(tenantFeedChannel()))).toBe(true)

    // The stream follows its tenant and user channels already; its agents not yet.
    globalFeed.publish({ type: 'runtime_readiness_changed', during: 'first load' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.received()).toBe('')
    firstLoad.resolve(['mine'])

    expect(await client.waitForData('"type":"runtime_readiness_changed"')).toBe(true)
    expect(follows(agentFeedChannel('mine'))).toBe(true)
    expect(follows(agentFeedChannel('theirs'))).toBe(false)
    expect(follows(userFeedChannel('member'))).toBe(true)

    globalFeed.publish({ type: 'session_active', agentSlug: 'mine', sessionId: 's1' })
    globalFeed.publish({ type: 'session_active', agentSlug: 'theirs', sessionId: 's2' })
    globalFeed.publish({ type: 'session_idle', agentSlug: 'mine', sessionId: 's1' })

    expect(await client.waitForData('"type":"session_idle"')).toBe(true)
    expect(payloads(client).map((e) => [e.type, e.agentSlug])).toEqual([
      ['connected', undefined],
      ['runtime_readiness_changed', undefined],
      ['session_active', 'mine'],
      ['session_idle', 'mine'],
    ])
    expect(getAccessibleAgentSlugs).toHaveBeenCalledTimes(1)
    client.destroy()
  })

  it('admits an agent shared with the user after the stream opened', async () => {
    authMode.value = true
    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue([])
    const client = await connectSSE('invitee')
    expect(await client.waitForData('"type":"connected"')).toBe(true)
    expect(follows(agentFeedChannel('shared'))).toBe(false)

    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue(['shared'])
    collaborationEvents.publishCollaborationEvent(['invitee'], { type: 'agent_members_changed', agentSlug: 'shared' })
    expect(await client.waitForData('"type":"agent_members_changed"')).toBe(true)
    expect(await waitFor(() => follows(agentFeedChannel('shared')))).toBe(true)
    globalFeed.publish({ type: 'session_active', agentSlug: 'shared', sessionId: 's1' })

    expect(await client.waitForData('"sessionId":"s1"')).toBe(true)
    client.destroy()
  })

  it('stops carrying an agent once the user loses access to it, and leaves its channel', async () => {
    authMode.value = true
    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue(['shared'])
    const client = await connectSSE('leaver')
    expect(await client.waitForData('"type":"connected"')).toBe(true)
    globalFeed.publish({ type: 'session_active', agentSlug: 'shared', sessionId: 'before' })
    expect(await client.waitForData('"sessionId":"before"')).toBe(true)

    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue([])
    // The revocation is on the user's own channel; the event right behind it
    // is still on the agent's, which the stream follows until the reload lands.
    collaborationEvents.publishCollaborationEvent(['leaver'], { type: 'agent_access_revoked', agentSlug: 'shared' })
    globalFeed.publish({ type: 'session_active', agentSlug: 'shared', sessionId: 'after' })
    globalFeed.publish({ type: 'runtime_readiness_changed', marker: 'end' })

    expect(await client.waitForData('"marker":"end"')).toBe(true)
    expect(client.received()).toContain('agent_access_revoked')
    expect(client.received()).not.toContain('"sessionId":"after"')
    expect(await waitFor(() => !follows(agentFeedChannel('shared')))).toBe(true)
    client.destroy()
  })

  it('carries a newly created agent to its creator, and to no one else', async () => {
    authMode.value = true
    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue([])
    const [creator, bystander] = await Promise.all([connectSSE('creator'), connectSSE('bystander')])
    for (const client of [creator, bystander]) expect(await client.waitForData('"type":"connected"')).toBe(true)

    // The create route writes the owner row, then announces the agent to its members.
    vi.mocked(getAccessibleAgentSlugs).mockImplementation(async (userId) => (userId === 'creator' ? ['fresh'] : []))
    collaborationEvents.announceAgentCreated('fresh', ['creator'])
    expect(await waitFor(() => follows(agentFeedChannel('fresh')))).toBe(true)
    globalFeed.publish({ type: 'session_active', agentSlug: 'fresh', sessionId: 'first' })

    expect(await creator.waitForData('"sessionId":"first"')).toBe(true)
    expect(payloads(creator).map((e) => e.type)).toEqual(['connected', 'agent_created', 'session_active'])
    globalFeed.publish({ type: 'runtime_readiness_changed', marker: 'end' })
    expect(await bystander.waitForData('"marker":"end"')).toBe(true)
    expect(bystander.received()).not.toContain('fresh')
    expect(live().filter((entry) => entry.paths.includes(agentFeedChannel('fresh').path))).toHaveLength(1)
    creator.destroy()
    bystander.destroy()
  })

  it("ends the stream when the user's agents cannot be loaded", async () => {
    authMode.value = true
    vi.mocked(getAccessibleAgentSlugs).mockRejectedValue(new Error('database is locked'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/notifications/stream', headers: { 'x-test-user': 'unlucky' } },
        (res) => {
          res.resume()
          res.on('close', () => resolve())
        },
      )
      req.on('error', reject)
    })

    expect(await waitFor(() => live().length === 0)).toBe(true)
    expect(errors).toHaveBeenCalledWith(
      'Failed to load accessible agents for the notifications stream:',
      expect.any(Error),
    )
    errors.mockRestore()
  })

  it('sends a mention frame to its recipient only', async () => {
    authMode.value = true
    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue(['shared-agent'])
    const [mike, sara] = await Promise.all([connectSSE('mike'), connectSSE('sara')])
    for (const client of [mike, sara]) expect(await client.waitForData('"type":"connected"')).toBe(true)

    globalFeed.publish({ type: 'os_notification', agentSlug: 'shared-agent', recipientUserId: 'mike', title: 'Dana mentioned you' })
    globalFeed.publish({ type: 'os_notification', agentSlug: 'shared-agent', title: 'Session Complete' })

    expect(await mike.waitForData('Session Complete')).toBe(true)
    expect(await sara.waitForData('Session Complete')).toBe(true)
    expect(mike.received()).toContain('Dana mentioned you')
    expect(sara.received()).not.toContain('Dana mentioned you')
    mike.destroy()
    sara.destroy()
  })

  it('loads access afresh on reconnect and replays nothing from the gap', async () => {
    authMode.value = true
    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue(['a'])
    const first = await connectSSE('u')
    expect(await first.waitForData('"type":"connected"')).toBe(true)
    first.destroy()
    expect(await waitFor(() => live().length === 0)).toBe(true)

    globalFeed.publish({ type: 'session_active', agentSlug: 'a', sessionId: 'in-the-gap' })
    await backgroundSettled()
    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue(['a', 'b'])
    const second = await connectSSE('u')
    expect(await second.waitForData('"type":"connected"')).toBe(true)
    globalFeed.publish({ type: 'session_active', agentSlug: 'b', sessionId: 'after' })

    expect(await second.waitForData('"sessionId":"after"')).toBe(true)
    expect(second.received()).not.toContain('in-the-gap')
    expect(getAccessibleAgentSlugs).toHaveBeenCalledTimes(2)
    second.destroy()
  })
})

describe('across processes', () => {
  it('carries an event that another process of the tenant publishes', async () => {
    // Two clients of one backend are two processes of one tenant: this one
    // serves the stream, the other only publishes.
    await closeAppState()
    const backend = new LocalAppStateBackend()
    await initializeAppState(createLocalAppState({ backend }))
    trackSubscriptions()
    const otherProcess = new GlobalFeed(() => createLocalAppState({ backend }))
    authMode.value = true
    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue(['a'])
    const client = await connectSSE('u')
    expect(await client.waitForData('"type":"connected"')).toBe(true)

    otherProcess.publish({ type: 'session_active', agentSlug: 'a', sessionId: 'elsewhere' })
    otherProcess.publishToUsers(['u'], { type: 'agent_members_changed', agentSlug: 'a' })

    expect(await client.waitForData('"sessionId":"elsewhere"')).toBe(true)
    expect(await client.waitForData('"type":"agent_members_changed"')).toBe(true)
    client.destroy()
    expect(await waitFor(() => live().length === 0)).toBe(true)
  })
})

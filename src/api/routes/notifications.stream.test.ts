import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from 'hono'
import * as collaborationEvents from '@shared/lib/services/collaboration-events'
import type { GlobalFeedEvent } from '@shared/lib/notifications/global-feed'

/**
 * The notifications SSE stream over a real HTTP listener.
 *
 * `app.request()` never aborts: only a real socket teardown makes
 * `@hono/node-server` fire the stream's abort signal, and that signal is the
 * ONLY disconnect notification the handler ever gets — Hono's StreamingApi
 * swallows write errors, so a failed ping can't surface a disconnect. These
 * tests connect through a real socket, kill it, and assert the handler
 * releases both resources it holds per connection: its global-feed
 * subscription and the 30-second keep-alive interval.
 */

// Observable stand-in for the global feed's subscriber set, with the exact
// semantics of the real one (Set membership + unsubscribe deletes).
const { globalClients, abortBeforeHandler, authMode, authGate, streamCallbacks } = vi.hoisted(() => ({
  globalClients: new Set<(event: GlobalFeedEvent) => void>(),
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
}))

// Transparent pass-through around streamSSE, except it can pre-abort the
// stream to exercise the abort-raced-with-setup path. Hono's onAbort only
// registers a listener (it never replays a past abort), so without the
// handler's `stream.aborted` check this path would hang the wait forever.
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
        await cb(stream)
        streamCallbacks.finished++
      }),
  }
})

vi.mock('@shared/lib/notifications/global-feed', () => ({
  globalFeed: {
    subscribe: (listener: (event: GlobalFeedEvent) => void) => {
      globalClients.add(listener)
      return () => {
        globalClients.delete(listener)
      }
    },
  },
}))

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

afterEach(() => {
  vi.mocked(getAccessibleAgentSlugs).mockReset().mockResolvedValue([])
  globalClients.clear()
  abortBeforeHandler.value = false
  authMode.value = false
  authGate.value = null
  authGate.signals = []
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
  waitForData: (needle: string, timeoutMs?: number) => Promise<boolean>
}> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/notifications/stream', headers: { Accept: 'text/event-stream', 'x-test-user': userId } },
      (res) => {
        let buffer = ''
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
        })
        res.on('error', () => {})
        resolve({
          received: () => buffer,
          destroy: () => req.destroy(),
          waitForData: (needle, timeoutMs) => waitFor(() => buffer.includes(needle), timeoutMs),
        })
      },
    )
    req.on('error', reject)
  })
}

describe('GET /api/notifications/stream teardown', () => {
  it('registers a client and keep-alive on connect, and releases both on disconnect', async () => {
    const before = createdKeepAlives.size
    const client = await connectSSE()

    expect(await client.waitForData('"type":"connected"')).toBe(true)
    expect(globalClients.size).toBe(1)
    expect(createdKeepAlives.size).toBe(before + 1)

    client.destroy()

    expect(await waitFor(() => globalClients.size === 0)).toBe(true)
    expect(await waitFor(() => clearedKeepAlives.size === createdKeepAlives.size)).toBe(true)
  })

  it('still delivers notifications while connected (no premature teardown)', async () => {
    const client = await connectSSE()
    expect(await client.waitForData('"type":"connected"')).toBe(true)

    for (const callback of globalClients) {
      callback({ type: 'os_notification', title: 'hello-still-connected' })
    }

    expect(await client.waitForData('hello-still-connected')).toBe(true)
    expect(globalClients.size).toBe(1)

    client.destroy()
    expect(await waitFor(() => globalClients.size === 0)).toBe(true)
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
      expect(await waitFor(() => globalClients.size === 0)).toBe(true)
      expect(await waitFor(() => clearedKeepAlives.size === createdKeepAlives.size)).toBe(true)
    }
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
    expect(globalClients.size).toBe(0)
    expect(createdKeepAlives.size).toBe(created)
  })

  it('leaves no residue after repeated connect/disconnect cycles', async () => {
    for (let i = 0; i < 5; i++) {
      const client = await connectSSE()
      expect(await client.waitForData('"type":"connected"')).toBe(true)
      expect(globalClients.size).toBe(1)
      client.destroy()
      expect(await waitFor(() => globalClients.size === 0)).toBe(true)
    }

    expect(globalClients.size).toBe(0)
    expect(await waitFor(() => clearedKeepAlives.size === createdKeepAlives.size)).toBe(true)
  })
})


describe('collaboration hints over the existing stream', () => {
  it('delivers only to the targeted users and releases subscriptions on socket close', async () => {
    authMode.value = true
    const originalSubscribe = collaborationEvents.subscribeCollaborationEvents
    const stops: ReturnType<typeof vi.fn>[] = []
    const spy = vi.spyOn(collaborationEvents, 'subscribeCollaborationEvents').mockImplementation((...args) => {
      const stop = vi.fn(originalSubscribe(...args))
      stops.push(stop)
      return stop
    })
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
      expect(await waitFor(() => stops.length === 3 && stops.every((stop) => stop.mock.calls.length === 1))).toBe(true)
      spy.mockRestore()
    }
  })
})

describe('auth-mode access over the global feed', () => {
  const publish = (event: GlobalFeedEvent) => {
    for (const listener of globalClients) listener(event)
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

  it('carries only accessible agents, and keeps feed order across the first load', async () => {
    authMode.value = true
    const firstLoad = deferredLoad()
    vi.mocked(getAccessibleAgentSlugs).mockReturnValueOnce(firstLoad.promise)
    const client = await connectSSE('member')
    expect(await client.waitForData('"type":"connected"')).toBe(true)

    // Published while the user's agents are still loading: held, then judged in order.
    publish({ type: 'session_active', agentSlug: 'mine', sessionId: 's1' })
    publish({ type: 'session_active', agentSlug: 'theirs', sessionId: 's2' })
    publish({ type: 'runtime_readiness_changed' })
    publish({ type: 'session_idle', agentSlug: 'mine', sessionId: 's1' })
    firstLoad.resolve(['mine'])

    expect(await client.waitForData('"type":"session_idle"')).toBe(true)
    expect(payloads(client).map((e) => [e.type, e.agentSlug])).toEqual([
      ['connected', undefined],
      ['session_active', 'mine'],
      ['runtime_readiness_changed', undefined],
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

    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue(['shared'])
    collaborationEvents.publishCollaborationEvent(['invitee'], { type: 'agent_members_changed', agentSlug: 'shared' })
    publish({ type: 'session_active', agentSlug: 'shared', sessionId: 's1' })

    expect(await client.waitForData('"sessionId":"s1"')).toBe(true)
    client.destroy()
  })

  it('stops carrying an agent once the user loses access to it', async () => {
    authMode.value = true
    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue(['shared'])
    const client = await connectSSE('leaver')
    expect(await client.waitForData('"type":"connected"')).toBe(true)
    publish({ type: 'session_active', agentSlug: 'shared', sessionId: 'before' })
    expect(await client.waitForData('"sessionId":"before"')).toBe(true)

    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue([])
    collaborationEvents.publishCollaborationEvent(['leaver'], { type: 'agent_access_revoked', agentSlug: 'shared' })
    publish({ type: 'session_active', agentSlug: 'shared', sessionId: 'after' })
    publish({ type: 'runtime_readiness_changed', marker: 'end' })

    expect(await client.waitForData('"marker":"end"')).toBe(true)
    expect(client.received()).not.toContain('"sessionId":"after"')
    client.destroy()
  })

  it('carries a newly created agent to its creator', async () => {
    authMode.value = true
    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue([])
    const client = await connectSSE('creator')
    expect(await client.waitForData('"type":"connected"')).toBe(true)

    // The create route writes the owner row, then publishes agent_created.
    vi.mocked(getAccessibleAgentSlugs).mockResolvedValue(['fresh'])
    publish({ type: 'agent_created', agentSlug: 'fresh' })
    publish({ type: 'session_active', agentSlug: 'fresh', sessionId: 'first' })

    expect(await client.waitForData('"sessionId":"first"')).toBe(true)
    expect(payloads(client).map((e) => e.type)).toEqual(['connected', 'agent_created', 'session_active'])
    client.destroy()
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

    expect(await waitFor(() => globalClients.size === 0)).toBe(true)
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

    publish({ type: 'os_notification', agentSlug: 'shared-agent', recipientUserId: 'mike', title: 'Dana mentioned you' })
    publish({ type: 'os_notification', agentSlug: 'shared-agent', title: 'Session Complete' })

    expect(await mike.waitForData('Session Complete')).toBe(true)
    expect(await sara.waitForData('Session Complete')).toBe(true)
    expect(mike.received()).toContain('Dana mentioned you')
    expect(sara.received()).not.toContain('Dana mentioned you')
    mike.destroy()
    sara.destroy()
  })
})

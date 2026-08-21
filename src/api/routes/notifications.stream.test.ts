import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * The notifications SSE stream over a real HTTP listener.
 *
 * `app.request()` never aborts: only a real socket teardown makes
 * `@hono/node-server` fire the stream's abort signal, and that signal is the
 * ONLY disconnect notification the handler ever gets — Hono's StreamingApi
 * swallows write errors, so a failed ping can't surface a disconnect. These
 * tests connect through a real socket, kill it, and assert the handler
 * releases both resources it holds per connection: the global-notification
 * client callback and the 30-second keep-alive interval.
 */

// Observable stand-in for the persister's global-client registry, with the
// exact semantics of the real one (Set membership + unsubscribe deletes).
const { globalClients, abortBeforeHandler } = vi.hoisted(() => ({
  globalClients: new Set<(data: unknown) => void>(),
  // When true, the streamSSE wrapper below aborts the stream BEFORE the
  // route's handler body runs — deterministically reproducing a client that
  // disconnected during handler setup, i.e. before onAbort is registered.
  abortBeforeHandler: { value: false },
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
      }),
  }
})

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    addGlobalNotificationClient: (callback: (data: unknown) => void) => {
      globalClients.add(callback)
      return () => {
        globalClients.delete(callback)
      }
    },
  },
}))

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))

// Auth middleware: no-op in tests
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
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
}))

import notificationsRouter from './notifications'

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
  globalClients.clear()
  abortBeforeHandler.value = false
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
function connectSSE(): Promise<{
  received: () => string
  destroy: () => void
  waitForData: (needle: string, timeoutMs?: number) => Promise<boolean>
}> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/notifications/stream', headers: { Accept: 'text/event-stream' } },
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

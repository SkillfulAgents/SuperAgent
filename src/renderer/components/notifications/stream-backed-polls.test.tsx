// @vitest-environment jsdom
//
// The fallback polls of the queries the notifications stream keeps current,
// with the real handler and the real hooks over a fake stream and a counted
// API: how often each endpoint is asked while the stream delivers, that an
// event still updates at once, and what a drop, a silence and a reconnect do.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = MockEventSource.OPEN
  constructor(public url: string) {
    super()
    MockEventSource.instances.push(this)
  }
  close() {
    this.readyState = MockEventSource.CLOSED
  }
}
vi.stubGlobal('EventSource', MockEventSource)

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/lib/api')>(),
  apiFetch: mocks.apiFetch,
}))
vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => 'http://localhost:3000', isElectron: () => false }))
vi.mock('@renderer/lib/os-notifications', () => ({ showOSNotification: vi.fn() }))
vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({ selectedAgentSlug: null, view: { kind: 'home' } }),
}))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: false, canAccessAgent: () => true }),
}))
// The shared setup's useNavigate returns a new function per render, which would
// reopen the stream each time the handler renders; the router's is stable.
const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/react-router')>(),
  useNavigate: () => navigate,
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({ useUserSettings: () => ({ data: undefined }) }))
vi.mock('@renderer/hooks/use-mount-warnings', () => ({ setMountWarning: vi.fn() }))
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: [] }),
  resolveRouteAgentId: (slug: string | undefined) => slug,
}))

import { STREAM_BACKED_POLL_MS, STREAM_SILENT_AFTER_MS, noteNotificationStreamDown } from '@renderer/lib/notification-stream-health'
import { STREAM_RECONNECT_MS } from '@renderer/lib/stream-liveness'
import { useNotifications, useUnreadNotificationCount } from '@renderer/hooks/use-notifications'
import { usePlatformUnreadCount } from '@renderer/hooks/use-platform-notifications'
import { usePendingUserRequests } from '@shared/lib/tools/requests/use-pending-user-requests'
import { GlobalNotificationHandler } from './global-notification-handler'

const UNREAD = '/api/notifications/unread-count'
const INBOX = '/api/notifications?'
const PENDING = '/api/agents/agent-1/pending-requests'
const PLATFORM = '/api/platform-notifications/unread-count'
const ALL = [UNREAD, INBOX, PENDING, PLATFORM]

const server = {
  unread: 0,
  pending: [] as unknown[],
  platform: { count: 0, connected: false } as { count: number; connected?: boolean },
}
let requests: string[] = []

function Probe() {
  const unread = useUnreadNotificationCount()
  const inbox = useNotifications(20)
  const pending = usePendingUserRequests('agent-1', 's-1')
  const platform = usePlatformUnreadCount()
  return (
    <div>
      <span data-testid="unread">{unread.data?.count ?? '-'}</span>
      <span data-testid="inbox">{inbox.data?.total ?? '-'}</span>
      <span data-testid="pending">{pending.data?.length ?? '-'}</span>
      <span data-testid="platform">{platform.data?.count ?? '-'}</span>
    </div>
  )
}

const stream = () => MockEventSource.instances[MockEventSource.instances.length - 1]
const count = (url: string) => requests.filter((request) => request.startsWith(url)).length
const counts = () => Object.fromEntries(ALL.map((url) => [url, count(url)]))
const shown = (id: string) => screen.getByTestId(id).textContent

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function frame(data: unknown, es: MockEventSource = stream()) {
  await act(async () => {
    es.onmessage?.({ data: JSON.stringify(data) })
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** Time passing on a live stream: the server pings it every 30 s. */
async function advanceWithPings(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 30_000) {
    await advance(Math.min(30_000, ms - elapsed))
    await frame({ type: 'ping' })
  }
}

async function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <GlobalNotificationHandler />
      <Probe />
    </QueryClientProvider>,
  )
  await advance(0)
  requests = []
  return queryClient
}

describe('fallback polls behind the notifications stream', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockEventSource.instances = []
    requests = []
    server.unread = 0
    server.pending = []
    server.platform = { count: 0, connected: false }
    mocks.apiFetch.mockImplementation(async (url: string) => {
      requests.push(url)
      const body = url.startsWith(UNREAD) ? { count: server.unread }
        : url.startsWith(INBOX) ? { items: [], total: server.unread }
          : url.startsWith(PENDING) ? { requests: server.pending }
            : url.startsWith(PLATFORM) ? server.platform
              : {}
      return { ok: true, status: 200, json: async () => body }
    })
  })

  afterEach(() => {
    cleanup()
    noteNotificationStreamDown()
    vi.useRealTimers()
  })

  it('polls at each query\'s own rate until the stream says connected', async () => {
    await mount()
    await advance(60_000)
    expect(counts()).toEqual({ [UNREAD]: 1, [INBOX]: 2, [PENDING]: 2, [PLATFORM]: 2 })
  })

  it('asks each endpoint once per five minutes while the stream delivers', async () => {
    await mount()
    await frame({ type: 'connected' })
    requests = []

    await advanceWithPings(STREAM_BACKED_POLL_MS - 30_000)
    expect(counts()).toEqual({ [UNREAD]: 0, [INBOX]: 0, [PENDING]: 0, [PLATFORM]: 0 })

    await advanceWithPings(60_000)
    expect(counts()).toEqual({ [UNREAD]: 1, [INBOX]: 1, [PENDING]: 1, [PLATFORM]: 1 })

    // 30 minutes idle: 6 polls each, where it was 30 (unread) and 60 (the others).
    requests = []
    await advanceWithPings(30 * 60_000)
    expect(counts()).toEqual({ [UNREAD]: 6, [INBOX]: 6, [PENDING]: 6, [PLATFORM]: 6 })
  })

  it('a notification event updates the badge and the inbox at once', async () => {
    await mount()
    await frame({ type: 'connected' })
    requests = []

    server.unread = 3
    await frame({ type: 'os_notification', notificationType: 'session_complete', agentSlug: 'agent-1', sessionId: 's-9', title: 't', body: 'b' })
    expect(shown('unread')).toBe('3')
    expect(shown('inbox')).toBe('3')
    expect(count(UNREAD)).toBe(1)

    server.unread = 0
    await frame({ type: 'notifications_changed', agentSlug: 'agent-1' })
    expect(shown('unread')).toBe('0')
    expect(shown('inbox')).toBe('0')
  })

  it('a request event updates the pending requests at once', async () => {
    await mount()
    await frame({ type: 'connected' })
    requests = []

    server.pending = [{
      id: 'req-1', kind: 'secret', scope: { agentSlug: 'agent-1', sessionId: 's-1' },
      blocking: true, autoApproved: false, payload: { secretName: 'API_KEY' },
    }]
    await frame({ type: 'user_request_created', agentSlug: 'agent-1' })
    expect(shown('pending')).toBe('1')

    server.pending = []
    await frame({ type: 'user_request_resolved', agentSlug: 'agent-1' })
    expect(shown('pending')).toBe('0')
    expect(count(PENDING)).toBe(2)
  })

  it('the platform count is slow only while the platform is not connected', async () => {
    await mount()
    await frame({ type: 'connected' })
    requests = []
    await advanceWithPings(120_000)
    expect(count(PLATFORM)).toBe(0)

    // Connecting the platform is announced; from then on its count has no
    // complete push, so the poll returns to 30 s though the stream delivers.
    server.platform = { count: 2, connected: true }
    await frame({ type: 'platform_notifications_changed' })
    expect(shown('platform')).toBe('2')
    requests = []
    await advanceWithPings(120_000)
    expect(count(PLATFORM)).toBe(4)
    expect(count(UNREAD)).toBe(0)
  })

  it('a server that does not say whether the platform is connected is polled as before', async () => {
    server.platform = { count: 0 }
    await mount()
    await frame({ type: 'connected' })
    requests = []
    await advanceWithPings(120_000)
    expect(count(PLATFORM)).toBe(4)
  })

  it('returns to its own rates when the stream drops, and reads everything again on reconnect', async () => {
    await mount()
    await frame({ type: 'connected' })
    await advanceWithPings(60_000)
    requests = []

    // A network error: the browser retries by itself.
    const es = stream()
    es.readyState = MockEventSource.CONNECTING
    await act(async () => { es.onerror?.() })
    server.unread = 4
    await advance(60_000)
    expect(counts()).toEqual({ [UNREAD]: 1, [INBOX]: 2, [PENDING]: 2, [PLATFORM]: 2 })
    expect(shown('unread')).toBe('4')

    // Back: what changed during the gap is read at once, not at the next poll.
    server.unread = 7
    server.pending = [{
      id: 'req-2', kind: 'secret', scope: { agentSlug: 'agent-1', sessionId: 's-1' },
      blocking: true, autoApproved: false, payload: { secretName: 'API_KEY' },
    }]
    requests = []
    es.readyState = MockEventSource.OPEN
    await frame({ type: 'connected' })
    expect(counts()).toEqual({ [UNREAD]: 1, [INBOX]: 1, [PENDING]: 1, [PLATFORM]: 1 })
    expect(shown('unread')).toBe('7')
    expect(shown('pending')).toBe('1')

    requests = []
    await advanceWithPings(120_000)
    expect(counts()).toEqual({ [UNREAD]: 0, [INBOX]: 0, [PENDING]: 0, [PLATFORM]: 0 })
  })

  it('reopens a stream the server closed, at its own rates meanwhile, and resyncs on the new one', async () => {
    await mount()
    await frame({ type: 'connected' })
    requests = []

    const closed = stream()
    closed.readyState = MockEventSource.CLOSED
    await act(async () => {
      closed.onerror?.()
      closed.dispatchEvent(new Event('error'))
    })
    await advance(STREAM_RECONNECT_MS)
    expect(stream()).not.toBe(closed)
    await advance(60_000)
    expect(count(PENDING)).toBe(2)

    server.unread = 5
    requests = []
    await frame({ type: 'connected' })
    expect(shown('unread')).toBe('5')
    await advanceWithPings(120_000)
    expect(count(UNREAD)).toBe(1)
    expect(count(PENDING)).toBe(1)
  })

  it('returns to its own rates when the stream goes silent without an error', async () => {
    await mount()
    await frame({ type: 'connected' })
    requests = []

    // No ping for longer than the server would ever leave it.
    await advance(STREAM_SILENT_AFTER_MS + 15_000)
    requests = []
    await advance(60_000)
    expect(counts()).toEqual({ [UNREAD]: 1, [INBOX]: 2, [PENDING]: 2, [PLATFORM]: 2 })

    // The same stream speaks again: nothing was lost on it, so no resync, and slow again.
    await frame({ type: 'ping' })
    requests = []
    await advanceWithPings(120_000)
    expect(counts()).toEqual({ [UNREAD]: 0, [INBOX]: 0, [PENDING]: 0, [PLATFORM]: 0 })
  })

  it('returns to its own rates when the handler unmounts', async () => {
    await mount()
    await frame({ type: 'connected' })
    cleanup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>)
    await advance(0)
    requests = []
    await advance(60_000)
    expect(counts()).toEqual({ [UNREAD]: 1, [INBOX]: 2, [PENDING]: 2, [PLATFORM]: 2 })
  })
})

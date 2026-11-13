import { notificationClientId } from '@renderer/lib/notification-read-cache'
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, QueryObserver, type QueryKey } from '@tanstack/react-query'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock EventSource
class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  url: string
  readyState = MockEventSource.OPEN
  constructor(url: string) {
    super()
    this.url = url
    MockEventSource.instances.push(this)
  }
  close() {
    this.readyState = MockEventSource.CLOSED
  }
}

vi.stubGlobal('EventSource', MockEventSource)

vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: () => 'http://localhost:3000',
  isElectron: () => false,
}))

vi.mock('@renderer/lib/os-notifications', () => ({
  showOSNotification: vi.fn(),
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ success: true }) })),
}))

vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: vi.fn(() => ({ selectedAgentSlug: null, view: { kind: 'home' } })),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    isAuthMode: false,
    canAccessAgent: () => true,
  }),
}))

vi.mock('@renderer/hooks/use-notifications', () => ({
  useUnreadNotificationCount: () => ({ data: { count: 0 } }),
}))

vi.mock('@renderer/hooks/use-platform-notifications', () => ({
  usePlatformUnreadCount: () => ({ data: { count: 0 } }),
}))

// The global setup mocks useNavigate as an unobservable no-op; the platform
// notification click path needs an assertable spy.
const mockNavigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: vi.fn(() => ({ data: undefined })),
}))

vi.mock('@renderer/hooks/use-mount-warnings', () => ({
  setMountWarning: vi.fn(),
}))

import { STREAM_RECONNECT_MS } from '@renderer/lib/stream-liveness'
import { GlobalNotificationHandler, isRefetchableAfterOutage } from './global-notification-handler'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLatestEventSource(): MockEventSource {
  return MockEventSource.instances[MockEventSource.instances.length - 1]
}

function simulateSSEMessage(es: MockEventSource, data: unknown) {
  es.onmessage?.({ data: JSON.stringify(data) })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GlobalNotificationHandler — pending-request SSE pathway', () => {
  let queryClient: QueryClient

  beforeEach(async () => {
    MockEventSource.instances = []
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    // Reset module-level mocks that individual tests override with
    // `mockReturnValue`. vi.mock factories are NOT reset between tests, so
    // without this an override (a selected session, `notifyWhenUnfocused`,
    // etc.) leaks into later tests and makes them order-dependent.
    const { useRouteLocation } = await import('@renderer/router/use-route-location')
    const { useUserSettings } = await import('@renderer/hooks/use-user-settings')
    const { apiFetch } = await import('@renderer/lib/api')
    vi.mocked(useRouteLocation).mockReturnValue({
      view: { kind: 'home' },
      setAgent: vi.fn(),
    } as unknown as ReturnType<typeof useRouteLocation>)
    vi.mocked(useUserSettings).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useUserSettings>)
    // restoreAllMocks (afterEach) wipes the factory implementation, so
    // re-establish it: the handler does apiFetch(...).then(...) and a bare
    // undefined return would throw.
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ success: true }) } as unknown as Response)
  })

  afterEach(() => {
    cleanup()
    // Tests stub OS focus/visibility on `document`; undo so the next test
    // starts from the real jsdom defaults instead of an inherited
    // unfocused/visible state. restoreAllMocks restores the `hasFocus` spy;
    // `visibilityState` is redefined as an own accessor, so delete it to fall
    // back to the prototype getter.
    vi.restoreAllMocks()
    Reflect.deleteProperty(document, 'visibilityState')
  })

  it('runtime_readiness_changed patches same-status progress and refetches only on a status change', () => {
    const pulling = (percent: number) => ({
      status: 'PULLING_IMAGE',
      message: 'Pulling agent image',
      pullProgress: { status: `Pulling image... ${percent}%`, percent, completedLayers: 3, totalLayers: 7 },
    })
    queryClient.setQueryData(['runtime-status'], { runtimeReadiness: pulling(44), hasRunningAgents: false })
    queryClient.setQueryData(['settings'], { runtimeReadiness: pulling(44), app: { theme: 'dark' } })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    render(<QueryClientProvider client={queryClient}><GlobalNotificationHandler /></QueryClientProvider>)

    simulateSSEMessage(getLatestEventSource(), { type: 'runtime_readiness_changed', readiness: pulling(45) })
    expect(invalidate).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(['runtime-status'])).toEqual({ runtimeReadiness: pulling(45), hasRunningAgents: false })
    expect(queryClient.getQueryData(['settings'])).toEqual({ runtimeReadiness: pulling(45), app: { theme: 'dark' } })

    const ready = { status: 'READY', message: 'Ready', pullProgress: null }
    simulateSSEMessage(getLatestEventSource(), { type: 'runtime_readiness_changed', readiness: ready })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['runtime-status'] })
  })

  it('invalidates the current roster on changes and rejects malformed hints', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    render(<QueryClientProvider client={queryClient}><GlobalNotificationHandler /></QueryClientProvider>)
    simulateSSEMessage(getLatestEventSource(), { type: 'agent_members_changed', agentSlug: 'shared-agent' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agent-members', 'shared-agent'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['my-agent-roles'] })
    invalidate.mockClear()
    simulateSSEMessage(getLatestEventSource(), { type: 'agent_members_changed', agentSlug: 42 })
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('drops revoked data, updates roles immediately, and leaves the active agent', async () => {
    const { useRouteLocation } = await import('@renderer/router/use-route-location')
    vi.mocked(useRouteLocation).mockReturnValue({ selectedAgentSlug: 'launch-0123456789', view: { kind: 'agent' } } as unknown as ReturnType<typeof useRouteLocation>)
    queryClient.setQueryData(['agents'], [{ slug: '0123456789', displaySlug: 'launch-0123456789' }])
    queryClient.setQueryData(['agent-members', '0123456789'], [{ id: 'peer' }])
    queryClient.setQueryData(['agents', 'launch-0123456789'], { name: 'Private' })
    queryClient.setQueryData(['my-agent-roles'], { '0123456789': { role: 'viewer' }, other: { role: 'user' } })
    render(<QueryClientProvider client={queryClient}><GlobalNotificationHandler /></QueryClientProvider>)
    await act(async () => simulateSSEMessage(getLatestEventSource(), { type: 'agent_access_revoked', agentSlug: '0123456789' }))
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
    expect(queryClient.getQueryData(['my-agent-roles'])).toEqual({ other: { role: 'user' } })
    expect(queryClient.getQueryData(['agent-members', '0123456789'])).toBeUndefined()
    expect(queryClient.getQueryData(['agents', 'launch-0123456789'])).toBeUndefined()
  })

  it('user_request_created/resolved invalidate the unified store', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    const es = getLatestEventSource()

    // A dashboard-triggered review can exist with NO session anywhere — this
    // global event is its only push signal. Every review surface (in-chat
    // cards AND the dashboard panel) reads the unified store now.
    simulateSSEMessage(es, {
      type: 'user_request_created',
      request: {
        id: 'rev-1',
        kind: 'proxy_review',
        scope: { agentSlug: 'my-agent' },
        blocking: true,
        autoApproved: false,
        payload: {},
      },
    })
    simulateSSEMessage(es, {
      type: 'user_request_resolved',
      requestId: 'rev-1',
      kind: 'proxy_review',
      outcome: 'answered',
      scope: { agentSlug: 'my-agent' },
    })

    const keys = invalidateSpy.mock.calls.map((call) => (call[0] as { queryKey?: unknown[] }).queryKey?.[0])
    expect(keys.filter((k) => k === 'pending-user-requests')).toHaveLength(2)
  })

  // SECURITY: focus-aware gate — when an actionable session_waiting fires
  // while the window is visible-but-unfocused (jsdom: hasFocus() === false),
  // the OS notification should still fire because the user is effectively
  // "away". This guards the regression caught in review (S4): pre-fix the
  // gate looked only at visibilityState which doesn't flip on alt-tab.
  it('session_waiting fires OS notification when window is unfocused', async () => {
    const { showOSNotification } = await import('@renderer/lib/os-notifications')
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    const es = getLatestEventSource()
    simulateSSEMessage(es, {
      type: 'os_notification',
      notificationType: 'session_waiting',
      sessionId: 'sess-1',
      agentSlug: 'my-agent',
      title: 'Action Required',
      body: 'Need approval',
    })

    expect(showOSNotification).toHaveBeenCalled()
  })

  // For chattier types (chat-integration, session-complete) we keep the
  // visibility-only gate to avoid spam for users with side-panel windows.
  // When unfocused-but-visible, those types should NOT fire if the user is
  // viewing the same session.
  it('session_chat_integration suppressed when visible+viewing-session even if unfocused', async () => {
    const { showOSNotification } = await import('@renderer/lib/os-notifications')
    vi.mocked(showOSNotification).mockClear()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })

    // selection mock returns view.kind=home, so isViewingNotificationSession is false
    // for ANY session — to make this test meaningful we need to assert that the
    // visibility-only gate is what's used. Switch view to the same session.
    const { useRouteLocation } = await import('@renderer/router/use-route-location')
    vi.mocked(useRouteLocation).mockReturnValue({
      view: { kind: 'session', id: 'sess-1' },
      setAgent: vi.fn(),
    } as unknown as ReturnType<typeof useRouteLocation>)

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    const es = getLatestEventSource()
    simulateSSEMessage(es, {
      type: 'os_notification',
      notificationType: 'session_chat_integration',
      sessionId: 'sess-1',
      agentSlug: 'my-agent',
      title: 'Chat Add-on Connected',
      body: 'Slack',
    })

    expect(showOSNotification).not.toHaveBeenCalled()
  })

  it('session_complete fires when notifyWhenUnfocused is on and window unfocused', async () => {
    const { showOSNotification } = await import('@renderer/lib/os-notifications')
    vi.mocked(showOSNotification).mockClear()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })

    const { useRouteLocation } = await import('@renderer/router/use-route-location')
    vi.mocked(useRouteLocation).mockReturnValue({
      view: { kind: 'session', id: 'sess-1' },
      setAgent: vi.fn(),
    } as unknown as ReturnType<typeof useRouteLocation>)

    const { useUserSettings } = await import('@renderer/hooks/use-user-settings')
    vi.mocked(useUserSettings).mockReturnValue({
      data: {
        notifications: {
          enabled: true,
          sessionComplete: true,
          sessionWaiting: true,
          sessionScheduled: true,
          notifyWhenUnfocused: true,
        },
      },
    } as unknown as ReturnType<typeof useUserSettings>)

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    const es = getLatestEventSource()
    simulateSSEMessage(es, {
      type: 'os_notification',
      notificationType: 'session_complete',
      sessionId: 'sess-1',
      agentSlug: 'my-agent',
      title: 'Demo Agent finished',
      body: 'The report is ready.',
    })

    expect(showOSNotification).toHaveBeenCalledWith(
      'Demo Agent finished',
      'The report is ready.',
      undefined,
      expect.objectContaining({
        context: expect.objectContaining({
          agentSlug: 'my-agent',
          sessionId: 'sess-1',
        }),
      }),
    )
  })

  it('session_complete suppressed when notifyWhenUnfocused is off and viewing session', async () => {
    const { showOSNotification } = await import('@renderer/lib/os-notifications')
    vi.mocked(showOSNotification).mockClear()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })

    const { useRouteLocation } = await import('@renderer/router/use-route-location')
    vi.mocked(useRouteLocation).mockReturnValue({
      view: { kind: 'session', id: 'sess-1' },
      setAgent: vi.fn(),
    } as unknown as ReturnType<typeof useRouteLocation>)

    const { useUserSettings } = await import('@renderer/hooks/use-user-settings')
    vi.mocked(useUserSettings).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useUserSettings>)

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    const es = getLatestEventSource()
    simulateSSEMessage(es, {
      type: 'os_notification',
      notificationType: 'session_complete',
      sessionId: 'sess-1',
      agentSlug: 'my-agent',
      title: 'Done',
      body: 'Session complete',
    })

    expect(showOSNotification).not.toHaveBeenCalled()
  })

  it('marks the DB notification read (no popup) when actively viewing the focused session', async () => {
    const { showOSNotification } = await import('@renderer/lib/os-notifications')
    const { apiFetch } = await import('@renderer/lib/api')
    vi.mocked(showOSNotification).mockClear()
    vi.mocked(apiFetch).mockClear()

    // Window focused + visible, user is looking at sess-1.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })

    const { useRouteLocation } = await import('@renderer/router/use-route-location')
    vi.mocked(useRouteLocation).mockReturnValue({
      view: { kind: 'session', id: 'sess-1' },
      setAgent: vi.fn(),
    } as unknown as ReturnType<typeof useRouteLocation>)

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    const es = getLatestEventSource()
    simulateSSEMessage(es, {
      type: 'os_notification',
      notificationType: 'session_complete',
      notificationId: 'notif-9',
      sessionId: 'sess-1',
      agentSlug: 'my-agent',
      title: 'Done',
      body: 'Session complete',
    })

    // No OS popup (the user is watching it live), but the backend-created
    // record is marked read so the unread badge doesn't inflate.
    expect(showOSNotification).not.toHaveBeenCalled()
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/notifications/notif-9/read', expect.objectContaining({ method: 'POST' })))
  })

  it('also invalidates sessions query (for sidebar awaiting_input indicator)', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    const es = getLatestEventSource()

    simulateSSEMessage(es, {
      type: 'session_awaiting_input',
      agentSlug: 'my-agent',
      review: { type: 'proxy_review_request', reviewId: 'r-1' },
    })

    const sessionCalls = invalidateSpy.mock.calls.filter(
      (call) => {
        const opts = call[0] as { queryKey?: unknown[] }
        return opts.queryKey?.[0] === 'sessions'
      }
    )
    expect(sessionCalls.length).toBe(1)
    expect((sessionCalls[0][0] as { queryKey: unknown[] }).queryKey).toEqual(['sessions', 'my-agent'])
  })

  it('session_input_provided optimistically clears the awaiting flag in every cached projection', () => {
    const sessionBase = {
      agentSlug: 'my-agent',
      name: 'S',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      isActive: true,
    }
    queryClient.setQueryData(['sessions', 'my-agent'], [
      { ...sessionBase, id: 'sess-1', isAwaitingInput: true },
      { ...sessionBase, id: 'sess-2' },
    ])
    queryClient.setQueryData(['session', 'sess-1', 'my-agent'], {
      ...sessionBase, id: 'sess-1', isAwaitingInput: true,
    })
    const agentBase = { slug: 'my-agent', displaySlug: 'my-agent', name: 'My Agent', status: 'running' }
    queryClient.setQueryData(['agents'], [{ ...agentBase, hasSessionsAwaitingInput: true }])
    queryClient.setQueryData(['agents', 'my-agent'], { ...agentBase, hasSessionsAwaitingInput: true })

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), {
      type: 'session_input_provided',
      agentSlug: 'my-agent',
      sessionId: 'sess-1',
    })

    // Patched synchronously — no refetch round-trip involved.
    const sessions = queryClient.getQueryData<{ id: string; isAwaitingInput?: boolean }[]>(['sessions', 'my-agent'])
    expect(sessions?.[0].isAwaitingInput).toBe(false)
    const detail = queryClient.getQueryData<{ isAwaitingInput?: boolean }>(['session', 'sess-1', 'my-agent'])
    expect(detail?.isAwaitingInput).toBe(false)
    const agents = queryClient.getQueryData<{ hasSessionsAwaitingInput?: boolean }[]>(['agents'])
    expect(agents?.[0].hasSessionsAwaitingInput).toBe(false)
    const agentDetail = queryClient.getQueryData<{ hasSessionsAwaitingInput?: boolean }>(['agents', 'my-agent'])
    expect(agentDetail?.hasSessionsAwaitingInput).toBe(false)
  })

  it('session_awaiting_input optimistically raises the awaiting flag on session and rollup', () => {
    const sessionBase = {
      agentSlug: 'my-agent',
      name: 'S',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      isActive: true,
    }
    queryClient.setQueryData(['sessions', 'my-agent'], [{ ...sessionBase, id: 'sess-1' }])
    queryClient.setQueryData(['agents'], [
      { slug: 'my-agent', displaySlug: 'my-agent', name: 'My Agent', status: 'running' },
    ])

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), {
      type: 'session_awaiting_input',
      agentSlug: 'my-agent',
      sessionId: 'sess-1',
    })

    const sessions = queryClient.getQueryData<{ isAwaitingInput?: boolean }[]>(['sessions', 'my-agent'])
    expect(sessions?.[0].isAwaitingInput).toBe(true)
    const agents = queryClient.getQueryData<{ hasSessionsAwaitingInput?: boolean }[]>(['agents'])
    expect(agents?.[0].hasSessionsAwaitingInput).toBe(true)
  })

  it('session_awaiting_input on an idle session raises awaiting without marking it working', () => {
    queryClient.setQueryData(['sessions', 'my-agent'], [{
      id: 'sess-1',
      agentSlug: 'my-agent',
      name: 'S',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messageCount: 1,
      isActive: false,
    }])

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), {
      type: 'session_awaiting_input',
      agentSlug: 'my-agent',
      sessionId: 'sess-1',
    })

    const [session] = queryClient.getQueryData<{ isActive?: boolean; isAwaitingInput?: boolean }[]>(['sessions', 'my-agent'])!
    expect(session.isAwaitingInput).toBe(true)
    expect(session.isActive).toBe(false)
  })

  it('session_idle optimistically clears working AND awaiting flags (teardown broadcasts no input_provided)', () => {
    const sessionBase = {
      agentSlug: 'my-agent',
      name: 'S',
      createdAt: new Date(),
      lastActivityAt: new Date(),
    }
    queryClient.setQueryData(['sessions', 'my-agent'], [
      { ...sessionBase, id: 'sess-1', isActive: true, isAwaitingInput: true },
    ])
    queryClient.setQueryData(['agents'], [
      {
        slug: 'my-agent',
        displaySlug: 'my-agent',
        name: 'My Agent',
        status: 'running',
        hasActiveSessions: true,
        hasSessionsAwaitingInput: true,
      },
    ])

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), {
      type: 'session_idle',
      agentSlug: 'my-agent',
      sessionId: 'sess-1',
      isActive: false,
    })

    const sessions = queryClient.getQueryData<{ isActive?: boolean; isAwaitingInput?: boolean }[]>(['sessions', 'my-agent'])
    expect(sessions?.[0]).toMatchObject({ isActive: false, isAwaitingInput: false })
    const agents = queryClient.getQueryData<{ hasActiveSessions?: boolean; hasSessionsAwaitingInput?: boolean }[]>(['agents'])
    expect(agents?.[0]).toMatchObject({ hasActiveSessions: false, hasSessionsAwaitingInput: false })
  })

  it('actionable os_notification optimistically raises the unread dot on session and agent', () => {
    queryClient.setQueryData(['sessions', 'my-agent'], [
      {
        id: 'sess-1',
        agentSlug: 'my-agent',
        name: 'S',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        isActive: false,
      },
    ])
    queryClient.setQueryData(['agents'], [
      { slug: 'my-agent', displaySlug: 'my-agent', name: 'My Agent', status: 'running' },
    ])

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), {
      type: 'os_notification',
      notificationType: 'session_complete',
      sessionId: 'sess-1',
      agentSlug: 'my-agent',
      title: 'Done',
      body: 'Session complete',
    })

    const sessions = queryClient.getQueryData<{ hasUnreadNotifications?: boolean }[]>(['sessions', 'my-agent'])
    expect(sessions?.[0].hasUnreadNotifications).toBe(true)
    const agents = queryClient.getQueryData<{ hasUnreadNotifications?: boolean }[]>(['agents'])
    expect(agents?.[0].hasUnreadNotifications).toBe(true)
  })

  it('does not raise the unread dot when the popup is suppressed by the active session view', async () => {
    // Viewing sess-1 with the tab visible — the handler marks the record read
    // instead of popping, so the dot must not be raised either.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    const { useRouteLocation } = await import('@renderer/router/use-route-location')
    vi.mocked(useRouteLocation).mockReturnValue({
      view: { kind: 'session', id: 'sess-1' },
      setAgent: vi.fn(),
    } as unknown as ReturnType<typeof useRouteLocation>)

    queryClient.setQueryData(['sessions', 'my-agent'], [
      {
        id: 'sess-1',
        agentSlug: 'my-agent',
        name: 'S',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        isActive: false,
      },
    ])

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), {
      type: 'os_notification',
      notificationType: 'session_complete',
      notificationId: 'notif-1',
      sessionId: 'sess-1',
      agentSlug: 'my-agent',
      title: 'Done',
      body: 'Session complete',
    })

    const sessions = queryClient.getQueryData<{ hasUnreadNotifications?: boolean }[]>(['sessions', 'my-agent'])
    expect(sessions?.[0].hasUnreadNotifications).toBeUndefined()
  })

  it('suppressed notification clears an already-cached unread dot once the record is marked read', async () => {
    const { apiFetch } = await import('@renderer/lib/api')
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({
      success: true, readState: { count: 0, mentions: 0, agents: [{
        slug: 'my-agent', hasUnreadNotifications: false, hasUnreadMention: false,
        markedUnreadSessionIds: [], unreadSessionIds: [], mentionedSessionIds: [],
      }] },
    }) } as unknown as Response)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    const { useRouteLocation } = await import('@renderer/router/use-route-location')
    vi.mocked(useRouteLocation).mockReturnValue({
      view: { kind: 'session', id: 'sess-1' },
      setAgent: vi.fn(),
    } as unknown as ReturnType<typeof useRouteLocation>)

    // Simulates the top-of-case ['sessions'] refetch having landed with the
    // server's committed unread row while the user is watching the session.
    queryClient.setQueryData(['sessions', 'my-agent'], [
      {
        id: 'sess-1',
        agentSlug: 'my-agent',
        name: 'S',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        isActive: false,
        hasUnreadNotifications: true,
      },
    ])
    queryClient.setQueryData(['agents'], [
      { slug: 'my-agent', displaySlug: 'my-agent', name: 'My Agent', status: 'running', hasUnreadNotifications: true },
    ])

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), {
      type: 'os_notification',
      notificationType: 'session_complete',
      notificationId: 'notif-1',
      sessionId: 'sess-1',
      agentSlug: 'my-agent',
      title: 'Done',
      body: 'Session complete',
    })

    // The mark-read POST is async — the dot comes off once it resolves.
    await waitFor(() => {
      const sessions = queryClient.getQueryData<{ hasUnreadNotifications?: boolean }[]>(['sessions', 'my-agent'])
      expect(sessions?.[0].hasUnreadNotifications).toBe(false)
    })
    const agents = queryClient.getQueryData<{ hasUnreadNotifications?: boolean }[]>(['agents'])
    expect(agents?.[0].hasUnreadNotifications).toBe(false)
  })

  it.each(['notifications_changed', 'agent_access_revoked', 'agent_members_changed'])('%s refreshes list, unified counts and every unread projection', type => {
    const keys = [['notifications', 15, 0, 'all'], ['notifications', 'unread-count'], ['agents'], ['sessions', 'a'], ['session', 's1', 'a']]
    keys.forEach(key => queryClient.setQueryData(key, {}))
    render(<QueryClientProvider client={queryClient}><GlobalNotificationHandler /></QueryClientProvider>)
    simulateSSEMessage(getLatestEventSource(), { type, agentSlug: 'a' })
    keys.forEach(key => expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true))
  })

  it('ignores the initiating cache’s echo but refreshes another window', () => {
    const key = ['notifications', 'unread-count']
    queryClient.setQueryData(key, { count: 0 })
    render(<QueryClientProvider client={queryClient}><GlobalNotificationHandler /></QueryClientProvider>)
    simulateSSEMessage(getLatestEventSource(), { type: 'notifications_changed', agentSlug: 'a', sourceClientId: notificationClientId(queryClient) })
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false)
    simulateSSEMessage(getLatestEventSource(), { type: 'notifications_changed', agentSlug: 'a', sourceClientId: crypto.randomUUID() })
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it('platform_notifications_changed refreshes the proxy-live inbox queries', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), { type: 'platform_notifications_changed' })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['platform-notifications'] })
  })

  it('session_mention_withdrawn refreshes the inbox, the session list and the agent rows', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), {
      type: 'session_mention_withdrawn', agentSlug: 'agent-x', sessionId: 'sess-1', recipientUserId: 'user-b',
    })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notifications'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sessions'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['session'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agents'] })
  })

  it('webhook_relay_changed replaces the cached relay status', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )
    const status = { available: false, unavailableReason: 'platform_disconnected', transport: 'idle', lastClaimAt: null }

    simulateSSEMessage(getLatestEventSource(), { type: 'webhook_relay_changed', status })

    expect(queryClient.getQueryData(['webhook-relay'])).toEqual(status)
  })

  it('platform_notification pops an OS notification whose click opens the detail route', async () => {
    const { showOSNotification } = await import('@renderer/lib/os-notifications')
    vi.mocked(showOSNotification).mockClear()
    mockNavigate.mockClear()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    const platformNotificationId = 'ntf_00000001-1111-1111-1111-111111111111'
    simulateSSEMessage(getLatestEventSource(), {
      type: 'os_notification',
      notificationType: 'platform_notification',
      platformNotificationId,
      title: 'Welcome',
      body: 'markdown body',
      actionContext: { kind: 'platform_notification', platformNotificationId },
    })

    // The proxy-live inbox/badge refresh fires alongside the popup.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['platform-notifications'] })

    expect(showOSNotification).toHaveBeenCalledTimes(1)
    const [title, body, onClick] = vi.mocked(showOSNotification).mock.calls[0]
    expect(title).toBe('Welcome')
    expect(body).toBe('markdown body')

    // Web Notifications wire the click straight to the detail route (the
    // write-through mark-read happens there on open).
    expect(onClick).toBeTypeOf('function')
    onClick!()
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/notifications/$id',
      params: { id: platformNotificationId },
    })
  })

  it('platform_notification popup respects the settings toggle', async () => {
    const { showOSNotification } = await import('@renderer/lib/os-notifications')
    vi.mocked(showOSNotification).mockClear()

    const { useUserSettings } = await import('@renderer/hooks/use-user-settings')
    vi.mocked(useUserSettings).mockReturnValue({
      data: { notifications: { enabled: true, platformNotification: false } },
    } as unknown as ReturnType<typeof useUserSettings>)

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), {
      type: 'os_notification',
      notificationType: 'platform_notification',
      platformNotificationId: 'ntf_00000001-1111-1111-1111-111111111111',
      title: 'Welcome',
      body: 'markdown body',
    })

    expect(showOSNotification).not.toHaveBeenCalled()
  })

  it('applies agent status events directly and refreshes only that agent\'s artifacts', () => {
    queryClient.setQueryData(['agents'], [{
      slug: 'agent-a',
      displaySlug: 'agent-a-display',
      name: 'Agent A',
      status: 'stopped',
      containerPort: null,
      sessionCount: 9,
    }])
    queryClient.setQueryData(['agents', 'agent-a'], {
      slug: 'agent-a',
      displaySlug: 'agent-a-display',
      name: 'Agent A',
      status: 'stopped',
      containerPort: null,
      sessionCount: 9,
    })
    queryClient.setQueryData(['artifacts', 'agent-a'], [])
    queryClient.setQueryData(['artifacts', 'agent-a-display'], [])
    queryClient.setQueryData(['artifacts', 'agent-b'], [])
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), {
      type: 'agent_status_changed',
      agentSlug: 'agent-a',
      status: 'running',
    })

    expect(queryClient.getQueryData<Array<{ status: string; sessionCount: number }>>(['agents'])?.[0])
      .toMatchObject({ status: 'running', sessionCount: 9 })
    expect(queryClient.getQueryData<{ status: string }>(['agents', 'agent-a'])?.status).toBe('running')
    expect(queryClient.getQueryState(['artifacts', 'agent-a'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['artifacts', 'agent-a-display'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['artifacts', 'agent-b'])?.isInvalidated).toBe(false)
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['agents'] })
  })

  describe('session lifecycle refetches', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    const callsWith = (spy: { mock: { calls: unknown[][] } }, queryKey: unknown[]) =>
      spy.mock.calls.filter(([filters]) => JSON.stringify(filters) === JSON.stringify({ queryKey })).length

    // Mounted queries whose fetches are counted, as the agent page and the sidebar mount them.
    function mountQueries(keys: QueryKey[], data: (key: QueryKey) => unknown) {
      const fetches = new Map<string, number>()
      const unsubscribes = keys.map((queryKey) => new QueryObserver(queryClient, {
        queryKey,
        queryFn: async () => {
          fetches.set(JSON.stringify(queryKey), (fetches.get(JSON.stringify(queryKey)) ?? 0) + 1)
          return data(queryKey)
        },
        staleTime: Infinity,
      }).subscribe(() => {}))
      return {
        count: (queryKey: QueryKey) => fetches.get(JSON.stringify(queryKey)) ?? 0,
        reset: () => fetches.clear(),
        unmount: () => unsubscribes.forEach((unsubscribe) => unsubscribe()),
      }
    }

    it('fetches a turn\'s agent once per burst under every route key, and no other agent', async () => {
      const agents = [{ slug: 'agent-a', displaySlug: 'agent-a-display' }, { slug: 'agent-b', displaySlug: 'agent-b' }]
      const queries = mountQueries(
        [['agents'], ['agents', 'agent-a'], ['agents', 'agent-a-display'], ['agents', 'agent-b'], ['sessions', 'agent-a'], ['artifacts', 'agent-a']],
        (key) => key[0] !== 'agents' ? [] : key.length === 1 ? agents : agents.find((agent) => agent.slug === key[1] || agent.displaySlug === key[1]),
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      queries.reset()
      render(
        <QueryClientProvider client={queryClient}>
          <GlobalNotificationHandler />
        </QueryClientProvider>
      )
      const es = getLatestEventSource()
      await act(async () => {
        simulateSSEMessage(es, { type: 'session_active', agentSlug: 'agent-a', sessionId: 's1' })
        await vi.advanceTimersByTimeAsync(100)
        simulateSSEMessage(es, { type: 'session_idle', agentSlug: 'agent-a', sessionId: 's1' })
        await vi.advanceTimersByTimeAsync(100)
        simulateSSEMessage(es, {
          type: 'os_notification', notificationType: 'session_complete', notificationId: 'n1',
          agentSlug: 'agent-a', sessionId: 's1', title: 'Agent A', body: 'Finished the report',
        })
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(queries.count(['agents'])).toBe(1)
      expect(queries.count(['agents', 'agent-a'])).toBe(1)
      expect(queries.count(['agents', 'agent-a-display'])).toBe(1)
      expect(queries.count(['agents', 'agent-b'])).toBe(0)
      // At once on the start, so a new session shows up; the end and its
      // completion notification share one fetch.
      expect(queries.count(['sessions', 'agent-a'])).toBe(2)
      // Read when the agent stops, not when it starts.
      expect(queries.count(['artifacts', 'agent-a'])).toBe(1)
      queries.unmount()
    })

    it('updates the cache for status flips of a listed session, fetching only what it cannot patch', async () => {
      const server = {
        agents: [{ slug: 'agent-a', displaySlug: 'agent-a', status: 'running' }],
        sessions: [{ id: 's1', agentSlug: 'agent-a', name: 'Weekly report', isActive: false, isAwaitingInput: false }],
        notable: [] as unknown[],
      }
      const queries = mountQueries(
        [['agents'], ['agents', 'agent-a'], ['sessions', 'agent-a'], ['sessions', 'agent-a', 'notable', 5]],
        (key) => key[0] === 'agents' ? (key.length === 1 ? server.agents : server.agents[0]) : key[2] === 'notable' ? server.notable : server.sessions,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      queries.reset()
      render(
        <QueryClientProvider client={queryClient}>
          <GlobalNotificationHandler />
        </QueryClientProvider>
      )
      const es = getLatestEventSource()
      // The server moves first, as it does before it publishes the event.
      const emit = async (type: string, session: object, agent: object) => act(async () => {
        server.sessions = [{ ...server.sessions[0], ...session }]
        server.notable = server.sessions
        server.agents = [{ ...server.agents[0], ...agent }]
        simulateSSEMessage(es, { type, agentSlug: 'agent-a', sessionId: 's1' })
        await vi.advanceTimersByTimeAsync(500)
      })

      // It starts: its rows and the agent flip in place. Only the slice of
      // live sessions, which does not hold it yet, is read again.
      await emit('session_active', { isActive: true }, { hasActiveSessions: true })
      expect(queryClient.getQueryData<{ isActive?: boolean }[]>(['sessions', 'agent-a'])?.[0].isActive).toBe(true)
      expect(queryClient.getQueryData<{ hasActiveSessions?: boolean }[]>(['agents'])?.[0].hasActiveSessions).toBe(true)
      expect(queries.count(['sessions', 'agent-a'])).toBe(0)
      expect(queries.count(['sessions', 'agent-a', 'notable', 5])).toBe(1)
      expect(queries.count(['agents'])).toBe(0)
      expect(queries.count(['agents', 'agent-a'])).toBe(0)

      // It asks for input: every list holds it, so nothing is read.
      await emit('session_awaiting_input', { isAwaitingInput: true }, { hasSessionsAwaitingInput: true })
      expect(queryClient.getQueryData<{ hasSessionsAwaitingInput?: boolean }>(['agents', 'agent-a'])?.hasSessionsAwaitingInput).toBe(true)
      expect(queries.count(['sessions', 'agent-a'])).toBe(0)
      expect(queries.count(['sessions', 'agent-a', 'notable', 5])).toBe(1)
      expect(queries.count(['agents'])).toBe(0)
      expect(queries.count(['agents', 'agent-a'])).toBe(0)

      // The input arrives: a clear rereads the live slice, which may drop
      // it, and confirms the agent, whose rollup counts sessions no list shows.
      await emit('session_input_provided', { isAwaitingInput: false }, { hasSessionsAwaitingInput: false })
      expect(queries.count(['sessions', 'agent-a'])).toBe(0)
      expect(queries.count(['sessions', 'agent-a', 'notable', 5])).toBe(2)
      expect(queries.count(['agents'])).toBe(1)
      expect(queries.count(['agents', 'agent-a'])).toBe(1)
      queries.unmount()
    })

    it('keeps a status patch when a read from before the event lands after it', async () => {
      const server = {
        agents: [{ slug: 'agent-a', displaySlug: 'agent-a', hasActiveSessions: false }],
        sessions: [{ id: 's1', agentSlug: 'agent-a', name: 'Weekly report', isActive: false, isAwaitingInput: false }],
      }
      const read = (key: QueryKey) => key[0] === 'sessions' ? server.sessions : key.length === 1 ? server.agents : server.agents[0]
      // A slow host: the server answers with its state when the read starts,
      // and the answer arrives a second later.
      const keys: QueryKey[] = [['agents'], ['agents', 'agent-a'], ['sessions', 'agent-a']]
      const unsubscribes = keys.map((queryKey) => new QueryObserver(queryClient, {
        queryKey,
        queryFn: async () => {
          const answer = read(queryKey)
          await new Promise((resolve) => setTimeout(resolve, 1000))
          return answer
        },
        staleTime: Infinity,
      }).subscribe(() => {}))
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      render(
        <QueryClientProvider client={queryClient}>
          <GlobalNotificationHandler />
        </QueryClientProvider>
      )
      await act(async () => {
        // The last turn's refresh is still on its way when the next turn starts.
        for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey, exact: true })
        await vi.advanceTimersByTimeAsync(0)
        server.sessions = [{ ...server.sessions[0], isActive: true }]
        server.agents = [{ ...server.agents[0], hasActiveSessions: true }]
        simulateSSEMessage(getLatestEventSource(), { type: 'session_active', agentSlug: 'agent-a', sessionId: 's1' })
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(queryClient.getQueryData<{ isActive?: boolean }[]>(['sessions', 'agent-a'])?.[0].isActive).toBe(true)
      expect(queryClient.getQueryData<{ hasActiveSessions?: boolean }[]>(['agents'])?.[0].hasActiveSessions).toBe(true)
      expect(queryClient.getQueryData<{ hasActiveSessions?: boolean }>(['agents', 'agent-a'])?.hasActiveSessions).toBe(true)
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    })

    it('reads a new session from the server', async () => {
      const queries = mountQueries(
        [['agents'], ['agents', 'agent-a'], ['sessions', 'agent-a']],
        (key) => key[0] === 'agents' ? (key.length === 1 ? [{ slug: 'agent-a', displaySlug: 'agent-a' }] : { slug: 'agent-a', displaySlug: 'agent-a' }) : [],
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      queries.reset()
      render(
        <QueryClientProvider client={queryClient}>
          <GlobalNotificationHandler />
        </QueryClientProvider>
      )
      await act(async () => {
        simulateSSEMessage(getLatestEventSource(), { type: 'session_active', agentSlug: 'agent-a', sessionId: 's2' })
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(queries.count(['sessions', 'agent-a'])).toBe(1)
      expect(queries.count(['agents'])).toBe(1)
      expect(queries.count(['agents', 'agent-a'])).toBe(1)
      queries.unmount()
    })

    it('leaves the full list and the notable slice alone for a hidden automated session', async () => {
      const agent = { slug: 'agent-a', displaySlug: 'agent-a' }
      const queries = mountQueries(
        [['agents'], ['agents', 'agent-a'], ['sessions', 'agent-a'], ['sessions', 'agent-a', 'notable', 5], ['sessions', 'agent-a', 'completed-one-time']],
        (key) => key[0] === 'agents' ? (key.length === 1 ? [agent] : agent) : [],
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      queries.reset()
      render(
        <QueryClientProvider client={queryClient}>
          <GlobalNotificationHandler />
        </QueryClientProvider>
      )
      const es = getLatestEventSource()
      await act(async () => {
        simulateSSEMessage(es, { type: 'session_active', agentSlug: 'agent-a', sessionId: 'cron-run-1', hidden: true })
        await vi.advanceTimersByTimeAsync(100)
        simulateSSEMessage(es, { type: 'session_idle', agentSlug: 'agent-a', sessionId: 'cron-run-1', hidden: true })
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(queries.count(['sessions', 'agent-a'])).toBe(0)
      expect(queries.count(['sessions', 'agent-a', 'notable', 5])).toBe(0)
      expect(queries.count(['sessions', 'agent-a', 'completed-one-time'])).toBe(2)
      // Its agent still confirms: the rollup counts sessions no list shows.
      expect(queries.count(['agents'])).toBe(1)
      expect(queries.count(['agents', 'agent-a'])).toBe(1)
      queries.unmount()
    })

    it('confirms todos and automation lists once per burst', () => {
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
      render(
        <QueryClientProvider client={queryClient}>
          <GlobalNotificationHandler />
        </QueryClientProvider>
      )
      const es = getLatestEventSource()
      simulateSSEMessage(es, { type: 'session_active', agentSlug: 'agent-a', sessionId: 's1' })
      simulateSSEMessage(es, { type: 'session_active', agentSlug: 'agent-b', sessionId: 's2' })
      simulateSSEMessage(es, { type: 'session_idle', agentSlug: 'agent-a', sessionId: 's1' })

      expect(callsWith(invalidateSpy, ['todos'])).toBe(0)
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(callsWith(invalidateSpy, ['todos'])).toBe(1)
      expect(callsWith(invalidateSpy, ['webhook-trigger-sessions'])).toBe(1)
      expect(callsWith(invalidateSpy, ['scheduled-task-sessions'])).toBe(1)
    })

    it('runs queued confirmations when the stream is torn down', () => {
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
      const { unmount } = render(
        <QueryClientProvider client={queryClient}>
          <GlobalNotificationHandler />
        </QueryClientProvider>
      )
      simulateSSEMessage(getLatestEventSource(), { type: 'session_idle', agentSlug: 'agent-a', sessionId: 's1' })
      expect(callsWith(invalidateSpy, ['todos'])).toBe(0)

      unmount()
      expect(callsWith(invalidateSpy, ['todos'])).toBe(1)
    })
  })

  it('marks only the announced dashboard thumbnail ready without a refetch', () => {
    queryClient.setQueryData(['agents'], [{
      slug: 'agent-a',
      displaySlug: 'agent-a',
      name: 'Agent A',
      status: 'running',
      containerPort: 3456,
      dashboards: [
        { slug: 'sales', name: 'Sales' },
        { slug: 'support', name: 'Support' },
      ],
    }])
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), {
      type: 'dashboard_screenshot_ready',
      agentSlug: 'agent-a',
      dashboardSlug: 'sales',
    })

    expect(queryClient.getQueryData<Array<{ dashboards: Array<Record<string, unknown>> }>>(['agents'])?.[0].dashboards)
      .toEqual([
        { slug: 'sales', name: 'Sales', hasScreenshot: true },
        { slug: 'support', name: 'Support' },
      ])
    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('applies a pushed dashboard status to cached artifacts and refetches the list', () => {
    queryClient.setQueryData(['agents'], [{
      slug: 'agent-a',
      displaySlug: 'agent-a-display',
      name: 'Agent A',
      status: 'running',
      containerPort: 3456,
    }])
    queryClient.setQueryData(['artifacts', 'agent-a'], [
      { slug: 'sales', name: 'Sales', description: '', status: 'starting', port: 5000 },
      { slug: 'support', name: 'Support', description: '', status: 'stopped', port: 0 },
    ])

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    simulateSSEMessage(getLatestEventSource(), {
      type: 'dashboard_status_changed',
      agentSlug: 'agent-a',
      dashboardSlug: 'sales',
      status: 'running',
    })

    expect(queryClient.getQueryData<Array<{ slug: string; status: string }>>(['artifacts', 'agent-a']))
      .toEqual([
        expect.objectContaining({ slug: 'sales', status: 'running' }),
        expect.objectContaining({ slug: 'support', status: 'stopped' }),
      ])
    expect(queryClient.getQueryState(['artifacts', 'agent-a'])?.isInvalidated).toBe(true)
  })

  it('agent_updated refreshes saved appearance in list and detail queries on other clients', () => {
    queryClient.setQueryData(['agents'], [])
    queryClient.setQueryData(['agents', 'agent-a'], {})
    render(<QueryClientProvider client={queryClient}><GlobalNotificationHandler /></QueryClientProvider>)
    simulateSSEMessage(getLatestEventSource(), { type: 'agent_updated', agentSlug: 'agent-a' })
    expect(queryClient.getQueryState(['agents'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['agents', 'agent-a'])?.isInvalidated).toBe(true)
  })

  it("volume_attention_changed refreshes every agent's drives and the drive list, so a status pill follows sync", () => {
    queryClient.setQueryData(['mounts', 'agent-a'], [])
    queryClient.setQueryData(['mounts', 'agent-b'], [])
    queryClient.setQueryData(['volume-definitions'], [])
    render(<QueryClientProvider client={queryClient}><GlobalNotificationHandler /></QueryClientProvider>)
    simulateSSEMessage(getLatestEventSource(), { type: 'volume_attention_changed' })
    for (const key of [['mounts', 'agent-a'], ['mounts', 'agent-b'], ['volume-definitions']]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    }
  })

  it('agent_created invalidates visible agents and personal roles together', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    // Producer contract: x-agent create broadcasts this exact shape after ACL writes.
    simulateSSEMessage(getLatestEventSource(), {
      type: 'agent_created',
      agentSlug: 'new-helper',
    })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agents'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['my-agent-roles'] })
  })

  it('refetches everything the feed keeps current on each connected, and nothing on open', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    // The server may still be setting up what the stream follows when it opens.
    const es = getLatestEventSource()
    es.onopen?.()
    expect(invalidateSpy).not.toHaveBeenCalled()

    simulateSSEMessage(es, { type: 'connected' })
    expect(invalidateSpy).toHaveBeenCalledTimes(1)
    expect(invalidateSpy).toHaveBeenCalledWith({ predicate: expect.any(Function) })

    // A browser-handled reconnect: once on connected, never on open as well.
    invalidateSpy.mockClear()
    es.onerror?.()
    es.onopen?.()
    simulateSSEMessage(es, { type: 'connected' })
    expect(invalidateSpy).toHaveBeenCalledTimes(1)
    expect(invalidateSpy).toHaveBeenCalledWith({ predicate: expect.any(Function) })
  })

  it('connected after a reconnect from an overflow refreshes schedules, widgets and requests', () => {
    // What the feed keeps current, with an LLM-backed query beside it.
    const kept = [
      ['scheduled-tasks', 'agent-a'],
      ['scheduled-task', 'task-1'],
      ['widgets', 'agent-a'],
      ['pending-user-requests'],
      ['sessions', 'agent-a'],
      ['agents'],
    ]
    const fill = () => {
      for (const key of [...kept, ['skill-publish-info', 'agent-a']]) queryClient.setQueryData(key, [])
    }
    render(<QueryClientProvider client={queryClient}><GlobalNotificationHandler /></QueryClientProvider>)
    const es = getLatestEventSource()
    es.onopen?.()
    simulateSSEMessage(es, { type: 'connected' })
    fill()

    // The server ended a stream that fell behind; the browser reconnects on
    // its own (not a fatal close), and the events in the gap are gone.
    es.readyState = MockEventSource.CONNECTING
    es.onerror?.()
    es.readyState = MockEventSource.OPEN
    es.onopen?.()
    for (const key of kept) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false)

    simulateSSEMessage(es, { type: 'connected' })
    for (const key of kept) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['skill-publish-info', 'agent-a'])?.isInvalidated).toBe(false)
  })

  it('connected skips reads whose first load landed after the stream was requested', () => {
    const now = Date.now()
    queryClient.setQueryData(['agents'], [], { updatedAt: now - 1_000 })
    render(<QueryClientProvider client={queryClient}><GlobalNotificationHandler /></QueryClientProvider>)
    const es = getLatestEventSource()

    // Startup reads that finished while the stream was being set up.
    queryClient.setQueryData(['settings'], {}, { updatedAt: now + 1_000 })
    queryClient.setQueryData(['runtime-status'], {}, { updatedAt: now + 1_000 })
    queryClient.setQueryData(['runtime-status'], {}, { updatedAt: now + 2_000 })
    simulateSSEMessage(es, { type: 'connected' })

    expect(queryClient.getQueryState(['agents'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['settings'])?.isInvalidated).toBe(false)
    // A second write means it held data before, so it may predate the stream.
    expect(queryClient.getQueryState(['runtime-status'])?.isInvalidated).toBe(true)

    // After a drop, the same read may have missed events: it refetches.
    vi.spyOn(Date, 'now').mockReturnValue(now + 5_000)
    es.readyState = MockEventSource.CONNECTING
    es.onerror?.()
    es.readyState = MockEventSource.OPEN
    simulateSSEMessage(es, { type: 'connected' })
    expect(queryClient.getQueryState(['settings'])?.isInvalidated).toBe(true)
    vi.mocked(Date.now).mockRestore()
  })
})

describe('stream healing', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    MockEventSource.instances = []
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function renderHandler() {
    return render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )
  }

  async function killLatest() {
    const es = getLatestEventSource()
    es.readyState = MockEventSource.CLOSED
    await act(async () => {
      es.dispatchEvent(new Event('error'))
    })
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('error at readyState 2 reopens, and connected on the reopened stream refetches everything mounted except LLM-backed queries', async () => {
    renderHandler()
    expect(MockEventSource.instances).toHaveLength(1)

    await killLatest()
    await advance(STREAM_RECONNECT_MS)

    expect(MockEventSource.instances).toHaveLength(2)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    getLatestEventSource().onopen?.()
    expect(invalidateSpy).not.toHaveBeenCalled()
    simulateSSEMessage(getLatestEventSource(), { type: 'connected' })
    expect(invalidateSpy).toHaveBeenCalledWith({ predicate: expect.any(Function) })
    expect(isRefetchableAfterOutage({ queryKey: ['sessions', 'a1'] })).toBe(true)
    for (const key of ['agent-template-publish-info', 'agent-template-pr-info', 'skill-publish-info', 'skill-pr-info']) {
      expect(isRefetchableAfterOutage({ queryKey: [key, 'a1'] })).toBe(false)
    }

    // A later reconnect the browser handles refetches the same way.
    invalidateSpy.mockClear()
    getLatestEventSource().onopen?.()
    simulateSSEMessage(getLatestEventSource(), { type: 'connected' })
    expect(invalidateSpy).toHaveBeenCalledTimes(1)
    expect(invalidateSpy).toHaveBeenCalledWith({ predicate: expect.any(Function) })
  })

  it('reopen delay doubles per consecutive fatal close and resets on open', async () => {
    renderHandler()

    await killLatest()
    await advance(STREAM_RECONNECT_MS)
    expect(MockEventSource.instances).toHaveLength(2)

    // Second consecutive fatal close: 2s, not 1s.
    await killLatest()
    await advance(STREAM_RECONNECT_MS)
    expect(MockEventSource.instances).toHaveLength(2)
    await advance(STREAM_RECONNECT_MS)
    expect(MockEventSource.instances).toHaveLength(3)

    // A successful open resets the ladder to 1s.
    getLatestEventSource().onopen?.()
    await killLatest()
    await advance(STREAM_RECONNECT_MS)
    expect(MockEventSource.instances).toHaveLength(4)
  })

  it('unmount does not reopen after a fatal close', async () => {
    const { unmount } = renderHandler()
    expect(MockEventSource.instances).toHaveLength(1)

    const first = getLatestEventSource()
    first.readyState = MockEventSource.CLOSED
    unmount()
    await act(async () => {
      first.dispatchEvent(new Event('error'))
      await vi.advanceTimersByTimeAsync(STREAM_RECONNECT_MS)
    })

    expect(MockEventSource.instances).toHaveLength(1)
  })
})

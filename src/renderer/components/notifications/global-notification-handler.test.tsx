// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  close() {}
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
  apiFetch: vi.fn(() => Promise.resolve({ ok: true })),
}))

vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: vi.fn(() => ({ selectedAgentSlug: null, view: { kind: 'home' } })),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    isAuthMode: false,
    user: null,
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

import { GlobalNotificationHandler } from './global-notification-handler'

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

describe('GlobalNotificationHandler — proxy review SSE pathway', () => {
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
    vi.mocked(apiFetch).mockResolvedValue({ ok: true } as unknown as Response)
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

  it('session_awaiting_input with review data invalidates proxy-reviews query', async () => {
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
      review: {
        type: 'proxy_review_request',
        reviewId: 'r-123',
      },
    })

    // Should have invalidated proxy-reviews for this agent
    const proxyReviewCalls = invalidateSpy.mock.calls.filter(
      (call) => {
        const opts = call[0] as { queryKey?: unknown[] }
        return opts.queryKey?.[0] === 'proxy-reviews'
      }
    )
    expect(proxyReviewCalls.length).toBe(1)
    expect((proxyReviewCalls[0][0] as { queryKey: unknown[] }).queryKey).toEqual(['proxy-reviews', 'my-agent'])
  })

  it('session_awaiting_input WITHOUT review data does NOT invalidate proxy-reviews', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    render(
      <QueryClientProvider client={queryClient}>
        <GlobalNotificationHandler />
      </QueryClientProvider>
    )

    const es = getLatestEventSource()

    // Normal session awaiting input (not a proxy review — e.g., user input request)
    simulateSSEMessage(es, {
      type: 'session_awaiting_input',
      agentSlug: 'my-agent',
    })

    const proxyReviewCalls = invalidateSpy.mock.calls.filter(
      (call) => {
        const opts = call[0] as { queryKey?: unknown[] }
        return opts.queryKey?.[0] === 'proxy-reviews'
      }
    )
    expect(proxyReviewCalls.length).toBe(0)
  })

  it('proxy_review_resolved event also invalidates proxy-reviews', () => {
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
      review: {
        type: 'proxy_review_resolved',
        reviewId: 'r-123',
        decision: 'allow',
      },
    })

    const proxyReviewCalls = invalidateSpy.mock.calls.filter(
      (call) => {
        const opts = call[0] as { queryKey?: unknown[] }
        return opts.queryKey?.[0] === 'proxy-reviews'
      }
    )
    expect(proxyReviewCalls.length).toBe(1)
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
      title: 'Chat Integration Connected',
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
      title: 'Done',
      body: 'Session complete',
    })

    expect(showOSNotification).toHaveBeenCalled()
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
    expect(apiFetch).toHaveBeenCalledWith('/api/notifications/notif-9/read', { method: 'POST' })
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
})

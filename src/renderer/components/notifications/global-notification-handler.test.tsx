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

vi.mock('@renderer/context/selection-context', () => ({
  useSelection: () => ({ selectedSessionId: null }),
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

vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: undefined }),
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

  beforeEach(() => {
    MockEventSource.instances = []
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
  })

  afterEach(() => {
    cleanup()
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
})

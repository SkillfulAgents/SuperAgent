// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// Capture the options object each hook hands to useQuery so we can pin the
// deliberately-chosen polling cadence. These intervals were lowered from their
// original values (messages 5s, chat sessions 10s, unread count 10s) as a
// reviewed perf trade-off; this test makes an accidental revert or further drift
// fail loudly.
const capturedOptions: Record<string, unknown>[] = []

// Sessions whose own event stream is open.
const openStreams = vi.hoisted(() => new Set<string>())
vi.mock('./use-message-stream', () => ({
  isSessionStreamOpen: (sessionId: string) => openStreams.has(sessionId),
}))

// useSettings asks who is reading; local mode may always read.
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: false, isAdmin: false }),
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: ((options: Record<string, unknown>) => {
      capturedOptions.push(options)
      return { data: undefined, isLoading: false, isError: false }
    }) as unknown as typeof actual.useQuery,
  }
})

import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMessages } from './use-messages'
import { useAgentIntegrationSessions } from './use-agent-integrations'
import { useAgent, useAgents } from './use-agents'
import { useRuntimeStatus } from './use-runtime-status'
import { useSettings } from './use-settings'
import { useNotifications, useUnreadNotificationCount } from './use-notifications'
import { usePlatformUnreadCount } from './use-platform-notifications'
import { usePendingUserRequests } from '@shared/lib/tools/requests/use-pending-user-requests'
import { noteNotificationStreamDown, noteNotificationStreamFrame } from '@renderer/lib/notification-stream-health'

// useMessages reads the query cache via useQueryClient (delta anchoring), so a
// real provider is needed even with useQuery itself mocked out.
const wrapper = ({ children }: { children: React.ReactNode }) =>
  createElement(QueryClientProvider, { client: new QueryClient() }, children)

describe('polling cadence (reviewed interval constants)', () => {
  beforeEach(() => {
    capturedOptions.length = 0
    openStreams.clear()
    noteNotificationStreamDown()
  })

  /** The interval the hook hands useQuery for the query whose key starts with `key`, as rendered last. */
  function pollOf(...key: unknown[]) {
    const opts = capturedOptions.findLast((options) => {
      const queryKey = options.queryKey as unknown[] | undefined
      return Array.isArray(queryKey) && key.every((part, i) => queryKey[i] === part)
    })
    return opts?.refetchInterval
  }

  function messagesPollMs() {
    renderHook(() => useMessages('session-1', 'agent-1'), { wrapper })
    const messagesQuery = capturedOptions.find((opts) => {
      const key = opts.queryKey as unknown[] | undefined
      return Array.isArray(key) && key[0] === 'messages'
    })
    return (messagesQuery?.refetchInterval as () => number)()
  }

  it('useMessages polls every 15s while the session has no open stream', () => {
    expect(messagesPollMs()).toBe(15000)
  })

  it('useMessages polls every 60s while the session\'s own stream is open', () => {
    openStreams.add('session-1')
    expect(messagesPollMs()).toBe(60000)
  })

  it('useUnreadNotificationCount polls every 60s while the notifications stream is not delivering', () => {
    renderHook(() => useUnreadNotificationCount())
    const opts = capturedOptions.find((options) => {
      const key = options.queryKey as unknown[] | undefined
      return Array.isArray(key) && key[0] === 'notifications' && key[1] === 'unread-count'
    })
    expect(opts?.refetchInterval).toBe(60000)
  })

  // Queries whose every change the notifications stream announces: their
  // poll is a net for an event that was never sent, five minutes wide while
  // the stream delivers, and their old rate when it does not.
  describe('behind the notifications stream', () => {
    const cases: Array<[string, number, () => unknown, unknown[]]> = [
      ['useUnreadNotificationCount', 60_000, () => useUnreadNotificationCount(), ['notifications', 'unread-count']],
      ['useNotifications', 30_000, () => useNotifications(20), ['notifications', 20]],
      ['usePendingUserRequests', 30_000, () => usePendingUserRequests('agent-1', 's-1'), ['pending-user-requests']],
    ]

    it.each(cases)('%s polls at its own rate without the stream, every 5 min with it', (_name, ownMs, hook, key) => {
      const { rerender } = renderHook(hook, { wrapper })
      expect(pollOf(...key)).toBe(ownMs)

      act(() => noteNotificationStreamFrame('connected'))
      rerender()
      expect(pollOf(...key)).toBe(300_000)

      act(() => noteNotificationStreamDown())
      rerender()
      expect(pollOf(...key)).toBe(ownMs)
    })

    it('usePlatformUnreadCount slows only for a platform that is not connected', () => {
      const interval = (data: unknown) => (pollOf('platform-notifications', 'unread-count') as (query: unknown) => number)({ state: { data } })
      const { rerender } = renderHook(() => usePlatformUnreadCount(), { wrapper })
      expect(interval({ count: 0, connected: false })).toBe(30_000)

      act(() => noteNotificationStreamFrame('connected'))
      rerender()
      expect(interval({ count: 0, connected: false })).toBe(300_000)
      // Connected: a new row is pushed only through the server's Realtime subscription.
      expect(interval({ count: 3, connected: true })).toBe(30_000)
      // An older server, an upstream failure, or nothing loaded yet.
      expect(interval({ count: 0 })).toBe(30_000)
      expect(interval(undefined)).toBe(30_000)
    })

    it('keeps reading the badges and requests on an event while the tab is hidden', () => {
      renderHook(() => { useUnreadNotificationCount(); usePlatformUnreadCount(); usePendingUserRequests('agent-1', 's-1') }, { wrapper })
      for (const key of [['notifications', 'unread-count'], ['platform-notifications', 'unread-count'], ['pending-user-requests']]) {
        const opts = capturedOptions.findLast((options) => key.every((part, i) => (options.queryKey as unknown[])[i] === part))
        expect(opts?.meta).toEqual({ refetchWhenHidden: true })
      }
    })
  })

  // Polls left as they were: the stream does not announce every change to
  // these, so slowing them would delay what only the poll can find.
  describe('not behind the notifications stream', () => {
    it('useRuntimeStatus (30 s), useSettings (60 s), useAgents (60 s) and useAgent (60 s) keep their rates with the stream delivering', () => {
      act(() => noteNotificationStreamFrame('connected'))
      renderHook(() => { useRuntimeStatus(); useSettings(); useAgents(); useAgent('agent-1') }, { wrapper })
      expect(pollOf('runtime-status')).toBe(30_000)
      expect((pollOf('settings') as (query: unknown) => number)({ state: { error: null } })).toBe(60_000)
      expect(pollOf('agents')).toBe(60_000)
      expect(capturedOptions.find((options) => (options.queryKey as unknown[]).length === 2 && (options.queryKey as unknown[])[0] === 'agents')?.refetchInterval).toBe(60_000)
    })
  })

  it('useAgentIntegrationSessions polls every 20s and not while backgrounded', () => {
    renderHook(() => useAgentIntegrationSessions('integration-1'))
    const opts = capturedOptions.at(-1)
    expect(opts?.refetchInterval).toBe(20000)
    expect(opts?.refetchIntervalInBackground).toBe(false)
  })
})

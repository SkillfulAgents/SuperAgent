// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: apiFetchMock, apiJson: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({}) }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: false, isAdmin: false }) }))

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { onlineManager, QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { createAppQueryClient } from '@renderer/lib/query-client'
import { updateAgentRuntimeCache } from '@renderer/lib/agent-cache'
import { useAgents, useResolvedAgentId } from './use-agents'
import { useSettings } from './use-settings'
import { useUserSettings } from './use-user-settings'
import { useRuntimeStatus } from './use-runtime-status'

/**
 * The four global queries are kept current by the notifications stream and
 * their mutations, so an observer that mounts on navigation must reuse the
 * cache. With the client's 5 s default each mount refetched: /api/agents,
 * /api/settings, /api/user-settings and /api/runtime-status on every click.
 * The window stays finite, so a missed event is still corrected.
 */
const QUERIES: Array<{
  name: string
  url: string
  key: string[]
  windowMs: number
  body: unknown
  useIt: () => { isSuccess: boolean }
  useAgain: () => unknown
}> = [
  { name: 'useAgents', url: '/api/agents', key: ['agents'], windowMs: 60_000, body: [], useIt: () => useAgents(), useAgain: () => useResolvedAgentId('some-agent') },
  { name: 'useSettings', url: '/api/settings', key: ['settings'], windowMs: 60_000, body: {}, useIt: () => useSettings(), useAgain: () => useSettings() },
  { name: 'useRuntimeStatus', url: '/api/runtime-status', key: ['runtime-status'], windowMs: 30_000, body: {}, useIt: () => useRuntimeStatus(), useAgain: () => useRuntimeStatus() },
  { name: 'useUserSettings', url: '/api/user-settings', key: ['user-settings'], windowMs: 5 * 60_000, body: {}, useIt: () => useUserSettings(), useAgain: () => useUserSettings() },
]

const START = new Date('2026-01-01T00:00:00Z').getTime()

let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

const fetches = (url: string) => apiFetchMock.mock.calls.filter(([called]) => called === url).length

beforeEach(() => {
  // Only the clock: staleness is `Date.now()` against the last update, while
  // the query's own promises and timers keep running for real.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  apiFetchMock.mockReset()
  client = createAppQueryClient()
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.useRealTimers()
})

describe.each(QUERIES)('$name staleTime', ({ url, key, windowMs, body, useIt, useAgain }) => {
  beforeEach(async () => {
    apiFetchMock.mockImplementation(async () => ({ ok: true, json: async () => body }))
    const first = renderHook(useIt, { wrapper })
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true))
    expect(fetches(url)).toBe(1)
  })

  it('does not fetch when another observer mounts inside the window', async () => {
    // Far past the client's 5 s default, which made this mount a request.
    vi.setSystemTime(START + windowMs - 1_000)
    renderHook(useAgain, { wrapper })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetches(url)).toBe(1)
  })

  it('fetches when an observer mounts after the window', async () => {
    vi.setSystemTime(START + windowMs + 1_000)
    renderHook(useAgain, { wrapper })
    await waitFor(() => expect(fetches(url)).toBe(2))
  })

  it('refetches at once on an invalidation, however fresh the data', async () => {
    vi.setSystemTime(START + 1_000)
    await client.invalidateQueries({ queryKey: key })
    expect(fetches(url)).toBe(2)
  })

  it('refetches on coming back online inside the window', async () => {
    vi.setSystemTime(START + 6_000)
    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    await waitFor(() => expect(fetches(url)).toBe(2))
  })
})

describe('settings after an agent starts or stops', () => {
  it('are read again by the next observer, without a request until then', async () => {
    // `hasRunningAgents` in the global settings locks Settings → Runtime and no
    // event carries it: the status change marks the cached settings stale.
    apiFetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({}) }))
    const first = renderHook(() => useSettings(), { wrapper })
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true))

    updateAgentRuntimeCache(client, 'some-agent', 'stopped')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetches('/api/settings')).toBe(1)

    renderHook(() => useSettings(), { wrapper })
    await waitFor(() => expect(fetches('/api/settings')).toBe(2))
  })
})

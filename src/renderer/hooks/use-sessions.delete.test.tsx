// @vitest-environment jsdom
/**
 * Deleting a session concerns one agent: its row leaves that agent's cached
 * lists at once, its detail is dropped instead of read again (a 404), and no
 * other agent's sessions or detail are refetched.
 */
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDeleteSession } from './use-sessions'
import type { ApiSession } from '@shared/lib/types/api'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  apiJson: vi.fn(),
}))

vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: vi.fn() }),
}))

const agentA = { slug: 'a', displaySlug: 'agent-a' }
const agentB = { slug: 'b', displaySlug: 'agent-b' }

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: [] }),
  // The route's display slug resolves to the agent's id, as the real one does.
  resolveRouteAgentId: (slug: string, agents?: { slug: string; displaySlug?: string }[]) =>
    agents?.find((agent) => agent.slug === slug || agent.displaySlug === slug)?.slug ?? slug,
}))

const session = (id: string, agentSlug: string) => ({ id, agentSlug, name: id }) as unknown as ApiSession

const own: unknown[][] = [
  ['agents'], ['agents', 'a'], ['agents', 'agent-a'],
  ['sessions', 'a'], ['sessions', 'a', 'notable', 25], ['sessions', 'agent-a', 'completed-one-time'],
  ['session', 'keep', 'a'], ['notifications', 'unread-count'],
]
const others: unknown[][] = [['agents', 'b'], ['agents', 'agent-b'], ['sessions', 'b'], ['session', 'gone', 'b'], ['session', 's9', 'b']]

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  queryClient.setQueryData(['agents'], [agentA, agentB])
  for (const agent of [agentA, agentB]) {
    queryClient.setQueryData(['agents', agent.slug], agent)
    queryClient.setQueryData(['agents', agent.displaySlug], agent)
  }
  queryClient.setQueryData(['sessions', 'a'], [session('gone', 'a'), session('keep', 'a')])
  queryClient.setQueryData(['sessions', 'a', 'notable', 25], [session('gone', 'a')])
  queryClient.setQueryData(['sessions', 'agent-a', 'completed-one-time'], [session('gone', 'a'), session('keep', 'a')])
  queryClient.setQueryData(['session', 'gone', 'a'], session('gone', 'a'))
  queryClient.setQueryData(['session', 'keep', 'a'], session('keep', 'a'))
  // Agent B happens to hold a session with the same id in its list.
  queryClient.setQueryData(['sessions', 'b'], [session('gone', 'b'), session('s9', 'b')])
  queryClient.setQueryData(['session', 's9', 'b'], session('s9', 'b'))
  queryClient.setQueryData(['notifications', 'unread-count'], { count: 0 })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const { result } = renderHook(useDeleteSession, { wrapper })
  return { result, queryClient }
}

describe('useDeleteSession cache updates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApiFetch.mockResolvedValue({ ok: true })
  })

  it.each(['a', 'agent-a'])('deleting through %s removes the row from every list of that agent and drops its detail', async (agentSlug) => {
    const { result, queryClient } = setup()

    result.current.mutate({ id: 'gone', agentSlug })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const ids = (key: unknown[]) => queryClient.getQueryData<ApiSession[]>(key)?.map((entry) => entry.id)
    expect(ids(['sessions', 'a'])).toEqual(['keep'])
    expect(ids(['sessions', 'a', 'notable', 25])).toEqual([])
    expect(ids(['sessions', 'agent-a', 'completed-one-time'])).toEqual(['keep'])
    expect(queryClient.getQueryState(['session', 'gone', 'a'])).toBeUndefined()
    // The agent's own data is refreshed under both of its keys; the removal does not mark the lists fresh.
    expect(own.filter((key) => !queryClient.getQueryState(key)?.isInvalidated)).toEqual([])
    // Another agent keeps its rows and stays fresh.
    expect(ids(['sessions', 'b'])).toEqual(['gone', 's9'])
    expect(others.filter((key) => queryClient.getQueryState(key)?.isInvalidated)).toEqual([])
  })

  it('does not read the deleted session again while its view is still mounted, nor another agent’s data', async () => {
    const { result, queryClient } = setup()
    const requests: string[] = []
    const mounted: unknown[][] = [['session', 'gone', 'a'], ['sessions', 'a'], ['agents'], ['sessions', 'b'], ['session', 's9', 'b'], ['agents', 'agent-b']]
    const stops = mounted.map((queryKey) => new QueryObserver(queryClient, {
      queryKey,
      staleTime: Infinity,
      queryFn: () => { requests.push(JSON.stringify(queryKey)); return queryClient.getQueryData(queryKey) ?? null },
    }).subscribe(() => {}))

    result.current.mutate({ id: 'gone', agentSlug: 'agent-a' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))

    expect(requests.sort()).toEqual(['["agents"]', '["sessions","a"]'])
    // Kept for the view that still shows it, and stale for whoever opens it next.
    expect(queryClient.getQueryState(['session', 'gone', 'a'])?.isInvalidated).toBe(true)
    stops.forEach((stop) => stop())
  })
})

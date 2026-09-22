// @vitest-environment jsdom
/**
 * The clear half of "mark as unread" fires from the SessionView mount effect on
 * EVERY session open, and almost always clears a flag that was never set.
 * Invalidating on that no-op would re-stat every transcript in the agent's
 * directory (the sessions list) and re-enrich every agent (the agents list) for
 * nothing, so the server reports whether it wrote and the hook gates on it.
 */
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSessionUnreadInCache, useSetSessionMarkedUnread } from './use-sessions'
import type { ApiSession } from '@shared/lib/types/api'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  apiJson: vi.fn(),
}))

vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => vi.fn(),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: [] }),
  resolveRouteAgentId: (slug: string) => slug,
}))

function respondWith(changed: boolean) {
  mockApiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, markedUnread: false, changed }),
  })
}

function renderMutation() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const { result } = renderHook(() => useSetSessionMarkedUnread(), { wrapper })
  return { result, invalidate }
}

describe('useSetSessionMarkedUnread invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not refetch anything when the clear was a no-op', async () => {
    respondWith(false)
    const { result, invalidate } = renderMutation()

    result.current.mutate({ sessionId: 'sess-1', agentSlug: 'agent-1', markedUnread: false })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('refetches the session list and the agent rollup when the flag actually changed', async () => {
    respondWith(true)
    const { result, invalidate } = renderMutation()

    result.current.mutate({ sessionId: 'sess-1', agentSlug: 'agent-1', markedUnread: true })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions', 'agent-1'] })
    // The agent row rolls session dots up into its own indicator.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agents'] })
  })

  it('raises with POST and clears with DELETE', async () => {
    respondWith(true)
    const { result } = renderMutation()

    result.current.mutate({ sessionId: 'sess-1', agentSlug: 'agent-1', markedUnread: true })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockApiFetch).toHaveBeenLastCalledWith('/api/agents/agent-1/sessions/sess-1/unread', {
      method: 'POST',
    })

    result.current.mutate({ sessionId: 'sess-1', agentSlug: 'agent-1', markedUnread: false })
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2))
    expect(mockApiFetch).toHaveBeenLastCalledWith('/api/agents/agent-1/sessions/sess-1/unread', {
      method: 'DELETE',
    })
  })
})

/**
 * The dot is rendered straight out of the caches, so opening a session takes it
 * down there first and lets the write and its refetch land afterwards.
 */
describe('clearSessionUnreadInCache', () => {
  function session(id: string, hasUnreadNotifications: boolean): ApiSession {
    return {
      id,
      agentSlug: 'agent-1',
      name: id,
      createdAt: new Date(0),
      lastActivityAt: new Date(0),
      messageCount: 1,
      hasUnreadNotifications,
    }
  }

  function seed() {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['sessions', 'agent-1'], [session('sess-1', true), session('sess-2', false)])
    queryClient.setQueryData(['sessions', 'agent-1', 'notable', 25], [session('sess-1', true)])
    queryClient.setQueryData(['session', 'sess-1', 'agent-1'], session('sess-1', true))
    queryClient.setQueryData(['agents'], [{ slug: 'agent-1', hasUnreadNotifications: true }])
    queryClient.setQueryData(['agents', 'agent-1'], { slug: 'agent-1', hasUnreadNotifications: true })
    return queryClient
  }

  function unreadIds(queryClient: QueryClient, key: unknown[]) {
    return (queryClient.getQueryData(key) as ApiSession[]).filter((s) => s.hasUnreadNotifications).map((s) => s.id)
  }

  it('clears the dot in the full list, the notable slice and the session entry', () => {
    const queryClient = seed()

    expect(clearSessionUnreadInCache(queryClient, 'agent-1', 'sess-1')).toBe(true)
    expect(unreadIds(queryClient, ['sessions', 'agent-1'])).toEqual([])
    expect(unreadIds(queryClient, ['sessions', 'agent-1', 'notable', 25])).toEqual([])
    expect((queryClient.getQueryData(['session', 'sess-1', 'agent-1']) as ApiSession).hasUnreadNotifications).toBe(false)
  })

  it('rolls the agent indicator down only once no other session is unread', () => {
    const queryClient = seed()
    queryClient.setQueryData(['sessions', 'agent-1'], [session('sess-1', true), session('sess-2', true)])

    clearSessionUnreadInCache(queryClient, 'agent-1', 'sess-1')
    expect(queryClient.getQueryData(['agents'])).toEqual([{ slug: 'agent-1', hasUnreadNotifications: true }])

    clearSessionUnreadInCache(queryClient, 'agent-1', 'sess-2')
    expect(queryClient.getQueryData(['agents'])).toEqual([{ slug: 'agent-1', hasUnreadNotifications: false }])
    expect(queryClient.getQueryData(['agents', 'agent-1'])).toEqual({
      slug: 'agent-1',
      hasUnreadNotifications: false,
    })
  })

  it('reports the no-op open and leaves the caches untouched', () => {
    const queryClient = seed()
    const before = queryClient.getQueryData(['sessions', 'agent-1'])

    expect(clearSessionUnreadInCache(queryClient, 'agent-1', 'sess-2')).toBe(false)
    expect(queryClient.getQueryData(['sessions', 'agent-1'])).toBe(before)
    expect(queryClient.getQueryData(['agents'])).toEqual([{ slug: 'agent-1', hasUnreadNotifications: true }])
  })

  it('leaves list entries that carry no unread flag alone', () => {
    const queryClient = seed()
    // Automation slices live under the same prefix with a different shape.
    queryClient.setQueryData(['sessions', 'agent-1', 'completed-one-time'], [{ id: 'sess-1', taskId: 'task-1' }])

    clearSessionUnreadInCache(queryClient, 'agent-1', 'sess-1')
    expect(queryClient.getQueryData(['sessions', 'agent-1', 'completed-one-time'])).toEqual([
      { id: 'sess-1', taskId: 'task-1' },
    ])
  })
})

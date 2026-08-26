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
import { useSetSessionMarkedUnread } from './use-sessions'

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

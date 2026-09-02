// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftsProvider, useDraftsStore } from '@renderer/context/drafts-context'
import { useForkSession } from './use-sessions'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  apiJson: vi.fn(),
}))

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  return createElement(QueryClientProvider, { client: queryClient }, createElement(DraftsProvider, null, children))
}

describe('useForkSession', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
  })

  it('seeds the fork cache and draft on success', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'fork-1', agentSlug: 'agent-a', name: 'Pricing (fork)' }),
    })
    const { result } = renderHook(() => ({ fork: useForkSession(), store: useDraftsStore() }), { wrapper })
    act(() => {
      result.current.store.set('session:src-1', 'unsent')
    })
    await act(async () => {
      await result.current.fork.mutateAsync({ sessionId: 'src-1', agentSlug: 'agent-a' })
    })
    expect(result.current.store.get('session:fork-1')).toBe('unsent')
    expect(result.current.store.get('session:src-1')).toBe('unsent')
    expect(queryClient.getQueryData(['session', 'fork-1', 'agent-a'])).toEqual(
      expect.objectContaining({ id: 'fork-1', agentSlug: 'agent-a' }),
    )
  })

  it('throws the server error text', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      text: async () => JSON.stringify({ error: 'Session is currently running' }),
    })
    const { result } = renderHook(() => useForkSession(), { wrapper })
    await expect(
      result.current.mutateAsync({ sessionId: 'src-1', agentSlug: 'agent-a' }),
    ).rejects.toThrow('Session is currently running')
  })
})

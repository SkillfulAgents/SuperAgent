// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftsProvider, useDraftsStore } from '@renderer/context/drafts-context'
import { useForkAndCompact, useForkSession } from './use-sessions'

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => mockNavigate }
})

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  apiJson: vi.fn(),
}))

const mockTrack = vi.fn()
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: mockTrack }),
}))

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  return createElement(QueryClientProvider, { client: queryClient }, createElement(DraftsProvider, null, children))
}

describe('useForkSession', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
    mockTrack.mockReset()
    mockNavigate.mockReset()
  })

  it('seeds the fork cache and draft, then opens the copy before resolving', async () => {
    // Navigation is held open so the test can see the mutation wait for it.
    let finishNavigation!: () => void
    mockNavigate.mockImplementation(() => new Promise<void>((resolve) => { finishNavigation = resolve }))
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'fork-1', agentSlug: 'agent-a', name: 'Pricing (fork)' }),
    })
    const { result } = renderHook(() => ({ fork: useForkSession(), store: useDraftsStore() }), { wrapper })
    act(() => {
      result.current.store.set('session:src-1', 'unsent')
    })
    await act(async () => {
      let settled = false
      const forked = result.current.fork.mutateAsync({ sessionId: 'src-1', agentSlug: 'agent-a' }).then(() => { settled = true })
      await vi.waitFor(() => expect(mockNavigate).toHaveBeenCalled())
      await Promise.resolve()
      // A caller that acts on the opened copy (e.g. sends into it) relies on this.
      expect(settled).toBe(false)
      finishNavigation()
      await forked
      expect(settled).toBe(true)
    })
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'agent-a', sessionId: 'fork-1' },
    })
    expect(result.current.store.get('session:fork-1')).toBe('unsent')
    expect(result.current.store.get('session:src-1')).toBe('unsent')
    expect(queryClient.getQueryData(['session', 'fork-1', 'agent-a'])).toEqual(
      expect.objectContaining({ id: 'fork-1', agentSlug: 'agent-a' }),
    )
    expect(mockTrack).toHaveBeenCalledWith('session_forked')
    expect(mockTrack).not.toHaveBeenCalledWith('session_fork_failed', expect.anything())
  })

  it('throws and logs the server error text', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockApiFetch.mockResolvedValue({
      ok: false,
      text: async () => JSON.stringify({ error: 'Session is currently running' }),
    })
    const { result } = renderHook(() => useForkSession(), { wrapper })
    await expect(
      result.current.mutateAsync({ sessionId: 'src-1', agentSlug: 'agent-a' }),
    ).rejects.toThrow('Session is currently running')
    expect(mockTrack).toHaveBeenCalledWith('session_fork_failed', { reason: 'Session is currently running' })
    expect(mockTrack).not.toHaveBeenCalledWith('session_forked')
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith('Failed to fork session:', expect.any(Error))
    err.mockRestore()
  })
})

describe('useForkAndCompact', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
    mockTrack.mockReset()
    mockNavigate.mockReset()
  })

  it('forks, opens the copy, then sends /compact into the copy', async () => {
    const order: string[] = []
    let finishNavigation!: () => void
    mockNavigate.mockImplementation(() => new Promise<void>((resolve) => {
      order.push('navigate')
      finishNavigation = resolve
    }))
    mockApiFetch.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url.endsWith('/fork')) {
        order.push('fork')
        return { ok: true, json: async () => ({ id: 'fork-1', agentSlug: 'agent-a', name: 'Pricing (fork)' }) }
      }
      order.push(`send:${url}:${init?.body ?? ''}`)
      return { ok: true, json: async () => ({ success: true, uuid: 'u1', queued: false }) }
    })
    const { result } = renderHook(() => useForkAndCompact(), { wrapper })
    await act(async () => {
      const done = result.current.mutateAsync({ sessionId: 'src-1', agentSlug: 'agent-a' })
      await vi.waitFor(() => expect(order).toContain('navigate'))
      await Promise.resolve()
      // The send waits for the copy to open; nothing is posted while navigation is pending.
      expect(order).toEqual(['fork', 'navigate'])
      finishNavigation()
      await done
    })
    expect(order).toEqual([
      'fork',
      'navigate',
      `send:/api/agents/agent-a/sessions/fork-1/messages:${JSON.stringify({ content: '/compact' })}`,
    ])
  })

  it('sends nothing when the fork fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockApiFetch.mockResolvedValue({
      ok: false,
      text: async () => JSON.stringify({ error: 'Session is currently running' }),
    })
    const { result } = renderHook(() => useForkAndCompact(), { wrapper })
    await expect(
      result.current.mutateAsync({ sessionId: 'src-1', agentSlug: 'agent-a' }),
    ).rejects.toThrow('Session is currently running')
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})

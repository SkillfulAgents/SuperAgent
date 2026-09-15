// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftsProvider, useDraftsStore } from '@renderer/context/drafts-context'
import {
  newSessionCarryoverKey,
  type NewSessionCarryover,
} from '@renderer/lib/new-session-carryover'
import type { SessionUsage } from '@shared/lib/types/agent'
import { useStaleSession } from './use-stale-session'

const { navigate, apiFetch } = vi.hoisted(() => ({ navigate: vi.fn(), apiFetch: vi.fn() }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => navigate }
})
vi.mock('@renderer/lib/api', () => ({ apiFetch, apiJson: vi.fn() }))
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: vi.fn() }),
}))

const staleUsage: SessionUsage = {
  inputTokens: 10_000,
  outputTokens: 1_000,
  cacheReadInputTokens: 100_000,
  cacheCreationInputTokens: 0,
  contextWindow: 200_000,
}
const forkResponse = {
  ok: true,
  json: async () => ({ id: 'fork-1', agentSlug: 'abc123def4', name: 'Conversation (fork)' }),
}
const sendResponse = {
  ok: true,
  json: async () => ({ success: true, uuid: 'message-1', queued: false }),
}

function Wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }))
  return createElement(QueryClientProvider, { client }, createElement(DraftsProvider, null, children))
}

function renderStale(overrides: Partial<Parameters<typeof useStaleSession>[0]> = {}) {
  const args = {
    sessionId: 'session-1',
    agentSlug: 'abc123def4',
    routeAgentSlug: 'friendly-agent-abc123def4',
    isActive: false,
    isWaitingBackground: false,
    isAwaitingInput: false,
    isViewOnly: false,
    lastActivityAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    contextUsage: staleUsage,
    ...overrides,
  }
  return renderHook(() => ({ stale: useStaleSession(args), store: useDraftsStore() }), { wrapper: Wrapper })
}

describe('useStaleSession', () => {
  beforeEach(() => {
    navigate.mockReset()
    apiFetch.mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  it('shows for an old, large session at rest and hides when ignored', () => {
    const { result } = renderStale()
    expect(result.current.stale.showNotice).toBe(true)
    act(() => result.current.stale.ignore())
    expect(result.current.stale.showNotice).toBe(false)
  })

  it('does not show while active or for view-only users', () => {
    expect(renderStale({ isActive: true }).result.current.stale.showNotice).toBe(false)
    expect(renderStale({ isViewOnly: true }).result.current.stale.showNotice).toBe(false)
  })

  it('moves the live composer into a new conversation and navigates home', () => {
    const { result } = renderStale()
    act(() => result.current.stale.registerSnapshot(() => ({
      text: 'Continue as a new task',
      attachments: [],
      model: 'sonnet',
      effort: 'high',
      speed: 'normal',
    })))
    act(() => result.current.stale.startFresh())

    expect(result.current.store.get('agent:abc123def4')).toBe('Continue as a new task')
    expect(result.current.store.get<NewSessionCarryover>(newSessionCarryoverKey('abc123def4'))).toEqual({
      attachments: [],
      model: 'sonnet',
      effort: 'high',
      speed: 'normal',
    })
    expect(result.current.store.get('session:session-1')).toBeUndefined()
    expect(navigate).toHaveBeenCalledWith({
      to: '/agents/$slug',
      params: { slug: 'friendly-agent-abc123def4' },
    })
  })

  it('blocks repeat and competing actions until the fork and compact send both settle', async () => {
    let releaseFork!: () => void
    let releaseSend!: () => void
    const forkPending = new Promise<void>((resolve) => { releaseFork = resolve })
    const sendPending = new Promise<void>((resolve) => { releaseSend = resolve })
    apiFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/fork')) {
        await forkPending
        return forkResponse
      }
      await sendPending
      return sendResponse
    })
    const { result } = renderStale()
    act(() => {
      result.current.store.set('session:session-1', 'Unsent draft')
      // Two selections in the same event must be guarded before the next render.
      result.current.stale.continueCompacted()
      result.current.stale.continueCompacted()
      result.current.stale.startFresh()
    })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    expect(result.current.stale.isPending).toBe(true)
    expect(navigate).not.toHaveBeenCalled()
    expect(result.current.store.get('session:session-1')).toBe('Unsent draft')

    await act(async () => releaseFork())
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    act(() => {
      result.current.stale.continueCompacted()
      result.current.stale.startFresh()
    })
    expect(result.current.stale.isPending).toBe(true)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'friendly-agent-abc123def4', sessionId: 'fork-1' },
    })
    expect(result.current.store.get('session:fork-1')).toBe('Unsent draft')
    expect(result.current.store.get('session:session-1')).toBe('Unsent draft')

    await act(async () => releaseSend())
    await waitFor(() => expect(result.current.stale.isPending).toBe(false))
    expect(apiFetch.mock.calls).toEqual([
      ['/api/agents/friendly-agent-abc123def4/sessions/session-1/fork', { method: 'POST' }],
      ['/api/agents/abc123def4/sessions/fork-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '/compact' }),
      }],
    ])
  })

  it.each(['fork', 'compact'] as const)('allows retry after a failed %s request', async (failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failedResponse = { ok: false, text: async () => JSON.stringify({ error: 'Request failed' }) }
    apiFetch.mockImplementation(async (url: string) => (
      url.endsWith('/fork') && failure === 'compact' ? forkResponse : failedResponse
    ))
    const { result } = renderStale()
    act(() => result.current.stale.continueCompacted())
    const failedRequestCount = failure === 'fork' ? 1 : 2
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(failedRequestCount))
    await waitFor(() => expect(result.current.stale.isPending).toBe(false))

    apiFetch.mockImplementation(async (url: string) => url.endsWith('/fork') ? forkResponse : sendResponse)
    act(() => result.current.stale.continueCompacted())
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(failedRequestCount + 2))
    await waitFor(() => expect(result.current.stale.isPending).toBe(false))
  })
})

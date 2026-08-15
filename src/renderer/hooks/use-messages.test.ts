// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// The hooks under test only need apiFetch; stub the siblings so the module
// import stays inert (upload/error-reporting pull in heavier dependencies).
const apiFetchMock = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))
vi.mock('@renderer/lib/error-reporting', () => ({
  captureRendererException: vi.fn(),
}))
vi.mock('@renderer/lib/upload', () => ({
  uploadFileChunked: vi.fn(),
}))

import {
  useMessages,
  useSubagentMessages,
  useWorkflowTree,
  useWorkflowAgentMessages,
} from './use-messages'

interface InflightRequest {
  url: string
  init?: RequestInit
  resolve: (body: unknown) => void
}

// apiFetch stub with real abort semantics: each call parks until the test
// resolves it, and rejects with an AbortError when its signal fires — the
// same observable behavior as fetch() in a browser.
let inflight: InflightRequest[] = []
function installHangingFetch() {
  inflight = []
  apiFetchMock.mockImplementation(
    (url: string, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        inflight.push({
          url,
          init,
          resolve: (body: unknown) => resolve({ ok: true, status: 200, json: async () => body }),
        })
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        )
      })
  )
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return Object.assign(wrapper, { queryClient })
}

beforeEach(() => {
  apiFetchMock.mockReset()
  installHangingFetch()
})

describe('useMessages abort wiring', () => {
  it('passes React Query’s per-fetch AbortSignal through to apiFetch', async () => {
    const wrapper = createWrapper()
    renderHook(() => useMessages('s1', 'agent-1'), { wrapper })

    await waitFor(() => expect(inflight).toHaveLength(1))
    expect(inflight[0].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300')
    expect(inflight[0].init?.signal).toBeInstanceOf(AbortSignal)
    expect(inflight[0].init?.signal?.aborted).toBe(false)
  })

  // The core of the OOM fix: a superseding invalidation must ABORT the
  // in-flight refetch (React Query v5's default cancelRefetch), not orphan it.
  // Before the signal was wired, superseded multi-MB /messages responses kept
  // being produced and buffered server-side while the client had moved on.
  // Note RQ only cancels once the cache holds data — an INITIAL fetch is
  // reused, not cancelled — which is exactly the incident's steady state
  // (session open, SSE-driven refetch storm).
  it('aborts the in-flight refetch when a new invalidation supersedes it', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })

    // Initial load settles — the cache now has data.
    await waitFor(() => expect(inflight).toHaveLength(1))
    inflight[0].resolve({ messages: [], nextCursor: null })
    await waitFor(() => expect(result.current.isFetching).toBe(false))

    // First invalidation starts a refetch… (same shape the SSE-driven
    // throttle uses: prefix key, refetch active)
    act(() => {
      void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
    })
    await waitFor(() => expect(inflight).toHaveLength(2))

    // …and a second invalidation while it is still in flight aborts it.
    act(() => {
      void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
    })
    await waitFor(() => expect(inflight).toHaveLength(3))
    expect(inflight[1].init?.signal?.aborted).toBe(true)
    expect(inflight[2].init?.signal?.aborted).toBe(false)
  })

  it('the superseding refetch still delivers data after the aborted one', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })

    await waitFor(() => expect(inflight).toHaveLength(1))
    inflight[0].resolve({ messages: [], nextCursor: null })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    act(() => {
      void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
    })
    await waitFor(() => expect(inflight).toHaveLength(2))
    act(() => {
      void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
    })
    await waitFor(() => expect(inflight).toHaveLength(3))

    inflight[2].resolve({
      messages: [{ id: 'm1', type: 'user', content: { text: 'hi' }, createdAt: '2026-01-01T00:00:00Z' }],
      nextCursor: null,
    })

    await waitFor(() => expect(result.current.data).toHaveLength(1))
    expect(result.current.data?.[0].id).toBe('m1')
    expect(result.current.isError).toBe(false)
  })
})

describe('sibling queryFns abort wiring', () => {
  it('useSubagentMessages passes the per-fetch AbortSignal', async () => {
    const wrapper = createWrapper()
    renderHook(() => useSubagentMessages('s1', 'agent-1', 'sub-1'), { wrapper })

    await waitFor(() => expect(inflight).toHaveLength(1))
    expect(inflight[0].url).toBe('/api/agents/agent-1/sessions/s1/subagent/sub-1/messages')
    expect(inflight[0].init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('useWorkflowTree passes the per-fetch AbortSignal', async () => {
    const wrapper = createWrapper()
    renderHook(() => useWorkflowTree('s1', 'agent-1', 'run-1'), { wrapper })

    await waitFor(() => expect(inflight).toHaveLength(1))
    expect(inflight[0].url).toBe('/api/agents/agent-1/sessions/s1/workflows/run-1/tree')
    expect(inflight[0].init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('useWorkflowAgentMessages passes the per-fetch AbortSignal', async () => {
    const wrapper = createWrapper()
    renderHook(() => useWorkflowAgentMessages('s1', 'agent-1', 'run-1', 'agent-3'), { wrapper })

    await waitFor(() => expect(inflight).toHaveLength(1))
    expect(inflight[0].url).toBe('/api/agents/agent-1/sessions/s1/workflows/run-1/agents/agent-3/messages')
    expect(inflight[0].init?.signal).toBeInstanceOf(AbortSignal)
  })
})

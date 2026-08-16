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
  useDeleteToolCall,
  useSubagentMessages,
  useWorkflowTree,
  useWorkflowAgentMessages,
  MESSAGES_FULL_REFETCH_INTERVAL_MS,
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

describe('useMessages forward delta', () => {
  const user = (id: string, text = 'q') => ({
    id,
    type: 'user' as const,
    content: { text },
    toolCalls: [],
    createdAt: '2026-01-01T00:00:00Z',
  })
  const assistant = (id: string, text = 'a') => ({
    id,
    type: 'assistant' as const,
    content: { text },
    toolCalls: [],
    createdAt: '2026-01-01T00:00:01Z',
  })

  async function settleInitialPage(
    wrapper: ReturnType<typeof createWrapper>,
    result: { current: { isFetching: boolean } },
    messages: unknown[]
  ) {
    await waitFor(() => expect(inflight).toHaveLength(1))
    expect(inflight[0].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300')
    inflight[0].resolve({ messages, nextCursor: 'older-cursor' })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
  }

  it('refetches as a forward delta anchored on the last settled item and merges the upserts', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
    // The trailing assistant may still merge streamed blocks → anchor is u1.
    await settleInitialPage(wrapper, result, [user('u1'), assistant('a1', 'stale')])

    act(() => {
      void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
    })
    await waitFor(() => expect(inflight).toHaveLength(2))
    expect(inflight[1].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300&after=u1')

    inflight[1].resolve({
      messages: [user('u1'), assistant('a1', 'fresh'), assistant('a2', 'new')],
      anchor: 'a1',
    })
    await waitFor(() => expect(result.current.data).toHaveLength(3))
    expect(result.current.data?.map((m) => m.id)).toEqual(['u1', 'a1', 'a2'])
    expect((result.current.data?.[1] as { content: { text: string } }).content.text).toBe('fresh')
    // Older-history paging state survives delta merges.
    expect(result.current.hasOlder).toBe(true)
  })

  it('falls back to a full fetch in the same refetch when the server answers resync', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
    await settleInitialPage(wrapper, result, [user('u1'), assistant('a1')])

    act(() => {
      void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
    })
    await waitFor(() => expect(inflight).toHaveLength(2))
    inflight[1].resolve({ messages: [], anchor: null, resync: true })

    await waitFor(() => expect(inflight).toHaveLength(3))
    expect(inflight[2].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300')
    inflight[2].resolve({ messages: [user('u9')], nextCursor: null })
    // Resync means the transcript was rewritten: u1/a1 may no longer exist, so
    // they must NOT survive in the older-history buffer.
    await waitFor(() => expect(result.current.data?.map((m) => m.id)).toEqual(['u9']))
  })

  it('treats a plain page response (pre-delta server) as the full fetch', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
    await settleInitialPage(wrapper, result, [user('u1'), assistant('a1')])

    act(() => {
      void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
    })
    await waitFor(() => expect(inflight).toHaveLength(2))
    // An old server ignores `after` and answers the trailing page envelope.
    inflight[1].resolve({ messages: [user('u1'), assistant('a1', 'full')], nextCursor: null })

    await waitFor(() =>
      expect((result.current.data?.[1] as { content: { text: string } }).content.text).toBe('full')
    )
    expect(inflight).toHaveLength(2)
  })

  it('does a full refetch when the periodic drift repair is due, then returns to deltas', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const wrapper = createWrapper()
      const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
      await settleInitialPage(wrapper, result, [user('u1'), assistant('a1')])

      vi.setSystemTime(Date.now() + MESSAGES_FULL_REFETCH_INTERVAL_MS + 1000)
      act(() => {
        void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
      })
      await waitFor(() => expect(inflight).toHaveLength(2))
      expect(inflight[1].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300')
      inflight[1].resolve({ messages: [user('u1'), assistant('a1')], nextCursor: null })
      await waitFor(() => expect(result.current.isFetching).toBe(false))

      // The full fetch restamped the cadence — the next refetch is a delta again.
      act(() => {
        void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
      })
      await waitFor(() => expect(inflight).toHaveLength(3))
      expect(inflight[2].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300&after=u1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fetches the full page while nothing is safely settled (lone streaming assistant)', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
    await settleInitialPage(wrapper, result, [assistant('a1')])

    act(() => {
      void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
    })
    await waitFor(() => expect(inflight).toHaveLength(2))
    expect(inflight[1].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300')
  })

  it('a tool-call deletion forces the next refetch to be a full page', async () => {
    // The rewrite can edit an assistant item BEFORE the delta anchor, which
    // deltas never re-serve — without expiring the full-fetch stamp the
    // deleted call would stay rendered until the periodic full repair.
    const wrapper = createWrapper()
    const { result } = renderHook(
      () => ({ messages: useMessages('s1', 'agent-1'), del: useDeleteToolCall() }),
      { wrapper }
    )
    await waitFor(() => expect(inflight).toHaveLength(1))
    inflight[0].resolve({ messages: [user('u1'), assistant('a1')], nextCursor: null })
    await waitFor(() => expect(result.current.messages.isFetching).toBe(false))

    let deletion: Promise<unknown>
    act(() => {
      deletion = result.current.del.mutateAsync({
        sessionId: 's1',
        agentSlug: 'agent-1',
        toolCallId: 't1',
      })
    })
    await waitFor(() => expect(inflight).toHaveLength(2))
    expect(inflight[1].url).toBe('/api/agents/agent-1/sessions/s1/tool-calls/t1')
    inflight[1].resolve({})
    await act(async () => {
      await deletion
    })

    await waitFor(() => expect(inflight).toHaveLength(3))
    expect(inflight[2].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300')

    // The refetch omits the rewritten-away assistant. That omission is
    // authoritative — the item must vanish, not slide into the older-history
    // buffer and resurface elsewhere in the transcript.
    inflight[2].resolve({ messages: [user('u1')], nextCursor: null })
    await waitFor(() => expect(result.current.messages.data?.map((m) => m.id)).toEqual(['u1']))
  })

  it('discards an older-history page that resolves after a resync', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
    await settleInitialPage(wrapper, result, [user('u1'), assistant('a1')])

    // Start paging older history; leave the request in flight.
    let olderDone: Promise<boolean>
    act(() => {
      olderDone = result.current.fetchOlder()
    })
    await waitFor(() => expect(inflight).toHaveLength(2))
    expect(inflight[1].url).toContain('cursor=older-cursor')

    // Meanwhile the transcript is rewritten: delta answers resync, the full
    // fetch replaces the page.
    act(() => {
      void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
    })
    await waitFor(() => expect(inflight).toHaveLength(3))
    inflight[2].resolve({ messages: [], anchor: null, resync: true })
    await waitFor(() => expect(inflight).toHaveLength(4))
    inflight[3].resolve({ messages: [user('u9')], nextCursor: null })
    await waitFor(() => expect(result.current.data?.map((m) => m.id)).toEqual(['u9']))

    // The pre-resync older page finally lands — stale history from the old
    // transcript generation must not commit.
    inflight[1].resolve({ messages: [user('u0-stale')], nextCursor: null })
    await act(async () => {
      expect(await olderDone).toBe(false)
    })
    expect(result.current.data?.map((m) => m.id)).toEqual(['u9'])
    // Nor may the stale page's terminal cursor latch older-history loading off.
    expect(result.current.hasOlder).toBe(false)
  })

  it('falls back to a full fetch when the delta window predates the cache', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
    await settleInitialPage(wrapper, result, [user('u1'), assistant('a1')])

    act(() => {
      void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
    })
    await waitFor(() => expect(inflight).toHaveLength(2))
    // Server widened past everything the client holds — splice point unknown.
    inflight[1].resolve({ messages: [user('u0'), user('u1'), assistant('a1')], anchor: 'u1' })

    await waitFor(() => expect(inflight).toHaveLength(3))
    expect(inflight[2].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300')
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

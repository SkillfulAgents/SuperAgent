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
  useSendMessage,
  useDeleteToolCall,
  useSubagentMessages,
  useWorkflowTree,
  useWorkflowAgentMessages,
  MESSAGES_FULL_REFETCH_INTERVAL_MS,
} from './use-messages'
import { captureRendererException } from '@renderer/lib/error-reporting'

interface InflightRequest {
  url: string
  init?: RequestInit
  resolve: (body: unknown) => void
  /** Answer with a server error. */
  fail: () => void
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
          fail: () => resolve({ ok: false, status: 500, json: async () => ({}) }),
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
    expect(inflight[0].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300&media=ref')
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

describe('useSendMessage session runtime cache', () => {
  const session = {
    id: 's1',
    agentSlug: 'agent-1',
    name: 'Session',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActivityAt: new Date('2026-01-01T00:00:00Z'),
    model: 'claude-opus-4-6',
    effort: 'medium' as const,
  }

  it('patches all cached session-detail spellings with accepted runtime options', async () => {
    const wrapper = createWrapper()
    wrapper.queryClient.setQueryData(['session', 's1', 'agent-1'], session)
    wrapper.queryClient.setQueryData(['session', 's1', 'display-agent-1'], session)
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, uuid: 'u1', queued: false }),
    })
    const { result } = renderHook(() => useSendMessage(), { wrapper })

    await act(() => result.current.mutateAsync({
      sessionId: 's1',
      agentSlug: 'agent-1',
      content: 'use sonnet',
      model: 'claude-sonnet-4-6',
      effort: 'high',
    }))

    expect(wrapper.queryClient.getQueryData(['session', 's1', 'agent-1'])).toMatchObject({
      model: 'claude-sonnet-4-6',
      effort: 'high',
    })
    expect(wrapper.queryClient.getQueryData(['session', 's1', 'display-agent-1'])).toMatchObject({
      model: 'claude-sonnet-4-6',
      effort: 'high',
    })
  })

  it('does not claim a queued message changed the session model', async () => {
    const wrapper = createWrapper()
    wrapper.queryClient.setQueryData(['session', 's1', 'agent-1'], session)
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, uuid: 'u1', queued: true }),
    })
    const { result } = renderHook(() => useSendMessage(), { wrapper })

    await act(() => result.current.mutateAsync({
      sessionId: 's1',
      agentSlug: 'agent-1',
      content: 'queued',
      model: 'claude-sonnet-4-6',
    }))

    expect(wrapper.queryClient.getQueryData(['session', 's1', 'agent-1'])).toMatchObject({
      model: 'claude-opus-4-6',
    })
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
    expect(inflight[0].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300&media=ref')
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
    expect(inflight[1].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300&after=u1&media=ref')

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
    expect(inflight[2].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300&media=ref')
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
      expect(inflight[1].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300&media=ref')
      inflight[1].resolve({ messages: [user('u1'), assistant('a1')], nextCursor: null })
      await waitFor(() => expect(result.current.isFetching).toBe(false))

      // The full fetch restamped the cadence — the next refetch is a delta again.
      act(() => {
        void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
      })
      await waitFor(() => expect(inflight).toHaveLength(3))
      expect(inflight[2].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300&after=u1&media=ref')
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
    expect(inflight[1].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300&media=ref')
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
    expect(inflight[2].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300&media=ref')

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
    inflight[3].resolve({ messages: [user('u9')], nextCursor: 'c2' })
    await waitFor(() => expect(result.current.data?.map((m) => m.id)).toEqual(['u9']))

    // The reset aborts the stale request outright — fencing alone would let a
    // hung request hold isFetchingOlder and block all fresh paging.
    expect(inflight[1].init?.signal?.aborted).toBe(true)
    await act(async () => {
      expect(await olderDone).toBe(false)
    })
    expect(result.current.data?.map((m) => m.id)).toEqual(['u9'])
    expect(result.current.isFetchingOlder).toBe(false)

    // Fresh paging starts immediately against the post-resync cursor.
    act(() => {
      void result.current.fetchOlder()
    })
    await waitFor(() => expect(inflight).toHaveLength(5))
    expect(inflight[4].url).toContain('cursor=c2')
  })

  it('walks past an older page that adds only items already on screen', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
    await settleInitialPage(wrapper, result, [user('u3'), assistant('a3')])

    let olderDone: Promise<boolean>
    act(() => {
      olderDone = result.current.fetchOlder()
    })
    await waitFor(() => expect(inflight).toHaveLength(2))
    // A replayed transcript serves copies of what is already shown first.
    inflight[1].resolve({ messages: [user('u3'), assistant('a3')], nextCursor: 'c2' })
    // The same call goes on to the next page instead of returning nothing.
    await waitFor(() => expect(inflight).toHaveLength(3))
    expect(inflight[2].url).toContain('cursor=c2')
    inflight[2].resolve({ messages: [user('u1'), assistant('a1')], nextCursor: null })

    await act(async () => {
      expect(await olderDone).toBe(true)
    })
    expect(result.current.data?.map((m) => m.id)).toEqual(['u1', 'a1', 'u3', 'a3'])
    expect(result.current.hasOlder).toBe(false)
  })

  it('starts after the repeated pages when a later page of the walk fails', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
    await settleInitialPage(wrapper, result, [user('u3'), assistant('a3')])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let olderDone: Promise<boolean>
    act(() => {
      olderDone = result.current.fetchOlder()
    })
    await waitFor(() => expect(inflight).toHaveLength(2))
    inflight[1].resolve({ messages: [user('u3'), assistant('a3')], nextCursor: 'c2' })
    await waitFor(() => expect(inflight).toHaveLength(3))
    inflight[2].fail()
    await act(async () => {
      expect(await olderDone).toBe(false)
    })
    expect(result.current.hasOlder).toBe(true)

    // The repeated page is not fetched again.
    act(() => {
      void result.current.fetchOlder()
    })
    await waitFor(() => expect(inflight).toHaveLength(4))
    expect(inflight[3].url).toContain('cursor=c2')
    warn.mockRestore()
  })

  it('reports more to load when the walk stops at its page cap', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
    await settleInitialPage(wrapper, result, [user('u3'), assistant('a3')])

    let olderDone: Promise<boolean>
    act(() => {
      olderDone = result.current.fetchOlder()
    })
    // Every page of the walk repeats what is on screen.
    for (let hop = 1; hop <= 25; hop++) {
      await waitFor(() => expect(inflight).toHaveLength(hop + 1))
      inflight[hop].resolve({ messages: [user('u3'), assistant('a3')], nextCursor: `c${hop}` })
    }

    // Nothing was added, but a caller loading toward a target must go on.
    await act(async () => {
      expect(await olderDone).toBe(true)
    })
    expect(inflight).toHaveLength(26)
    expect(result.current.hasOlder).toBe(true)
    act(() => {
      void result.current.fetchOlder()
    })
    await waitFor(() => expect(inflight).toHaveLength(27))
    expect(inflight[26].url).toContain('cursor=c25')
  })

  it('ends the walk when the server hands back a cursor it already paged from', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
    await settleInitialPage(wrapper, result, [user('u3'), assistant('a3')])
    vi.mocked(captureRendererException).mockClear()

    let olderDone: Promise<boolean>
    act(() => {
      olderDone = result.current.fetchOlder()
    })
    // Two pages that hand each other's cursor back: without the check the
    // walk would fetch them 25 times a call, on every call.
    await waitFor(() => expect(inflight).toHaveLength(2))
    expect(inflight[1].url).toContain('cursor=older-cursor')
    inflight[1].resolve({ messages: [user('u3'), assistant('a3')], nextCursor: 'c1' })
    await waitFor(() => expect(inflight).toHaveLength(3))
    expect(inflight[2].url).toContain('cursor=c1')
    inflight[2].resolve({ messages: [user('u2'), assistant('a2')], nextCursor: 'older-cursor' })

    // The page that closed the circle still shows.
    await act(async () => {
      expect(await olderDone).toBe(true)
    })
    expect(result.current.data?.map((m) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3'])
    expect(result.current.hasOlder).toBe(false)
    expect(captureRendererException).toHaveBeenCalledTimes(1)

    await act(async () => {
      expect(await result.current.fetchOlder()).toBe(false)
    })
    expect(inflight).toHaveLength(3)
  })

  it('runs one older walk at a time when called twice from one render', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
    await settleInitialPage(wrapper, result, [user('u3'), assistant('a3')])
    vi.mocked(captureRendererException).mockClear()

    // Both calls read the same render's isFetchingOlder (false).
    let first: Promise<boolean>
    let second: Promise<boolean>
    act(() => {
      first = result.current.fetchOlder()
      second = result.current.fetchOlder()
    })
    await waitFor(() => expect(inflight).toHaveLength(2))
    inflight[1].resolve({ messages: [user('u2'), assistant('a2')], nextCursor: 'c1' })
    await act(async () => {
      expect(await first).toBe(true)
      expect(await second).toBe(false)
    })
    expect(inflight).toHaveLength(2)

    // A second walk from `older-cursor`, answering after the next page, would
    // hand back `c1` as a cursor already paged from and end history.
    let next: Promise<boolean>
    act(() => {
      next = result.current.fetchOlder()
    })
    await waitFor(() => expect(inflight).toHaveLength(3))
    expect(inflight[2].url).toContain('cursor=c1')
    inflight[2].resolve({ messages: [user('u1'), assistant('a1')], nextCursor: 'c2' })
    await act(async () => {
      expect(await next).toBe(true)
    })
    expect(result.current.data?.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    expect(result.current.hasOlder).toBe(true)
    expect(captureRendererException).not.toHaveBeenCalled()
  })

  it('pages from a cursor again after the request for it failed', async () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
    await settleInitialPage(wrapper, result, [user('u3'), assistant('a3')])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(captureRendererException).mockClear()

    let olderDone: Promise<boolean>
    act(() => {
      olderDone = result.current.fetchOlder()
    })
    await waitFor(() => expect(inflight).toHaveLength(2))
    inflight[1].fail()
    await act(async () => {
      expect(await olderDone).toBe(false)
    })
    vi.mocked(captureRendererException).mockClear()

    // The same cursor, asked for a second time, is not a circle.
    act(() => {
      olderDone = result.current.fetchOlder()
    })
    await waitFor(() => expect(inflight).toHaveLength(3))
    expect(inflight[2].url).toContain('cursor=older-cursor')
    inflight[2].resolve({ messages: [user('u2'), assistant('a2')], nextCursor: 'c1' })
    await act(async () => {
      expect(await olderDone).toBe(true)
    })
    expect(result.current.hasOlder).toBe(true)
    expect(captureRendererException).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('drops an item deleted remotely from within the covered range on a periodic full fetch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const wrapper = createWrapper()
      const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
      await settleInitialPage(wrapper, result, [user('u1'), assistant('a1'), user('u2'), assistant('a2')])

      vi.setSystemTime(Date.now() + MESSAGES_FULL_REFETCH_INTERVAL_MS + 1000)
      act(() => {
        void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
      })
      await waitFor(() => expect(inflight).toHaveLength(2))
      // Another client deleted a1; the page still starts at u1, so a1's
      // absence is a rewrite, not turnover — it must not survive in `older`.
      inflight[1].resolve({ messages: [user('u1'), user('u2'), assistant('a2')], nextCursor: null })
      await waitFor(() => expect(result.current.data?.map((m) => m.id)).toEqual(['u1', 'u2', 'a2']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('items before the new page start still slide into older history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const wrapper = createWrapper()
      const { result } = renderHook(() => useMessages('s1', 'agent-1'), { wrapper })
      await settleInitialPage(wrapper, result, [user('u1'), assistant('a1'), user('u2'), assistant('a2')])

      vi.setSystemTime(Date.now() + MESSAGES_FULL_REFETCH_INTERVAL_MS + 1000)
      act(() => {
        void wrapper.queryClient.invalidateQueries({ queryKey: ['messages', 's1'] })
      })
      await waitFor(() => expect(inflight).toHaveLength(2))
      // The page advanced: u1/a1 fell off its start — genuine turnover.
      inflight[1].resolve({
        messages: [user('u2'), assistant('a2'), user('u3'), assistant('a3')],
        nextCursor: 'u2',
      })
      await waitFor(() =>
        expect(result.current.data?.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
      )
    } finally {
      vi.useRealTimers()
    }
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
    expect(inflight[2].url).toBe('/api/agents/agent-1/sessions/s1/messages?limit=300&media=ref')
  })
})

describe('sibling queryFns abort wiring', () => {
  it('useSubagentMessages passes the per-fetch AbortSignal', async () => {
    const wrapper = createWrapper()
    renderHook(() => useSubagentMessages('s1', 'agent-1', 'sub-1'), { wrapper })

    await waitFor(() => expect(inflight).toHaveLength(1))
    expect(inflight[0].url).toBe('/api/agents/agent-1/sessions/s1/subagent/sub-1/messages?limit=300&media=ref')
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
    expect(inflight[0].url).toBe('/api/agents/agent-1/sessions/s1/workflows/run-1/agents/agent-3/messages?limit=300&media=ref')
    expect(inflight[0].init?.signal).toBeInstanceOf(AbortSignal)
  })
})

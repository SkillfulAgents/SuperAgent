// @vitest-environment jsdom
/**
 * The sidebar's read of an agent's sessions is bounded: a few rows and the
 * count, never the whole list. The rows land under the ['sessions', slug]
 * prefix as a plain array, where the session-list cache updaters reach them.
 */
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { patchSessionInCaches } from '@renderer/lib/agent-cache'
import { useRecentSessions, useSessions, useSessionTotal } from './use-sessions'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  apiJson: vi.fn(),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useResolvedAgentId: (slug?: string) => slug ?? null,
  resolveRouteAgentId: (slug: string) => slug,
}))

const rows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `s${i + 1}`, agentSlug: 'agent-1', name: `Session ${i + 1}` }))

function mountRow(client: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  // Read during render, as a component would: the observer only reports the
  // fields a render used.
  return renderHook(() => {
    const { data, isSuccess } = useRecentSessions('agent-1')
    return { recent: { data, isSuccess }, total: useSessionTotal('agent-1') }
  }, { wrapper })
}

describe('useRecentSessions', () => {
  let client: QueryClient

  beforeEach(() => {
    mockApiFetch.mockReset()
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  it('asks for six rows and the total, and keeps the rows as a list under the sessions prefix', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ sessions: rows(6), total: 5000 }) })

    const { result } = mountRow(client)
    await waitFor(() => expect(result.current.recent.isSuccess).toBe(true))

    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/agents/agent-1/sessions?limit=6&with_total=true',
      { signal: expect.any(AbortSignal) },
    )
    expect(result.current.recent.data?.map((session) => session.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
    await waitFor(() => expect(result.current.total).toBe(5000))
    expect(client.getQueryData(['sessions', 'agent-1', 'recent', 6])).toHaveLength(6)
  })

  it("is refetched by an invalidation of the agent's sessions, and patched by a rename write-through", async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ sessions: rows(2), total: 2 }) })
    const { result } = mountRow(client)
    await waitFor(() => expect(result.current.recent.isSuccess).toBe(true))

    patchSessionInCaches(client, 'agent-1', 's2', (session) => ({ ...session, name: 'Renamed' }))
    await waitFor(() => expect(result.current.recent.data?.[1].name).toBe('Renamed'))

    // A delete elsewhere: the server now lists one session.
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ sessions: rows(1), total: 1 }) })
    await client.invalidateQueries({ queryKey: ['sessions', 'agent-1'] })
    await waitFor(() => expect(result.current.recent.data).toHaveLength(1))
    await waitFor(() => expect(result.current.total).toBe(1))
    expect(mockApiFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the newer read\'s total when a read it replaced answers last', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sessions: rows(6), total: 10 }) })
    const { result } = mountRow(client)
    await waitFor(() => expect(result.current.total).toBe(10))

    // Read A starts (10 sessions); a create invalidates and read B (11) replaces it.
    const replies: Array<(reply: unknown) => void> = []
    mockApiFetch.mockImplementation(() => new Promise((resolve) => replies.push(resolve)))
    void client.invalidateQueries({ queryKey: ['sessions', 'agent-1'] })
    await waitFor(() => expect(replies).toHaveLength(1))
    void client.invalidateQueries({ queryKey: ['sessions', 'agent-1'] })
    await waitFor(() => expect(replies).toHaveLength(2))
    const [replyA, replyB] = replies

    replyB({ ok: true, json: async () => ({ sessions: rows(6), total: 11 }) })
    await waitFor(() => expect(result.current.total).toBe(11))
    replyA({ ok: true, json: async () => ({ sessions: rows(6), total: 10 }) })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(result.current.total).toBe(11)
    expect(client.getQueryData(['session-total', 'agent-1'])).toBe(11)
  })

  it('reports no total for a server that answers the limited rows alone', async () => {
    client.setQueryData(['session-total', 'agent-1'], 9)
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => rows(6) })

    const { result } = mountRow(client)
    await waitFor(() => expect(result.current.recent.isSuccess).toBe(true))

    expect(result.current.recent.data).toHaveLength(6)
    await waitFor(() => expect(result.current.total).toBeUndefined())
  })
})

/**
 * A view that lists every session (the agent's home, its sessions page) keeps
 * the full list live. Its reads carry the slice, which then does not read for
 * itself, and leaving the view shows the newest rows the tab has, not the
 * slice's own older read.
 */
describe('useRecentSessions beside a live full list', () => {
  let client: QueryClient
  // The server's sessions, newest first.
  let server: Array<{ id: string; agentSlug: string; name: string }>
  const recentReads = () => mockApiFetch.mock.calls.filter(([url]) => String(url).includes('limit=')).length
  const fullReads = () => mockApiFetch.mock.calls.filter(([url]) => !String(url).includes('limit=')).length
  const ids = (list?: Array<{ id: string }>) => list?.map((session) => session.id)

  beforeEach(() => {
    mockApiFetch.mockReset()
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
    server = rows(8)
    mockApiFetch.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (url.includes('limit=')
        ? { sessions: server.slice(0, 6), total: server.length }
        : server),
    }))
  })

  function mountAgentHome() {
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    return renderHook(() => useSessions('agent-1'), { wrapper })
  }

  it('reads the full list only, once per invalidation, and carries its rows and count into the slice', async () => {
    const row = mountRow(client)
    await waitFor(() => expect(row.result.current.total).toBe(8))
    const home = mountAgentHome()
    await waitFor(() => expect(home.result.current.isSuccess).toBe(true))
    const before = { recent: recentReads(), full: fullReads() }

    // A session started elsewhere (an automation, another tab).
    server = [{ id: 'new', agentSlug: 'agent-1', name: 'New' }, ...server]
    await client.invalidateQueries({ queryKey: ['sessions', 'agent-1'] })

    await waitFor(() => expect(ids(row.result.current.recent.data)?.[0]).toBe('new'))
    expect(row.result.current.recent.data).toHaveLength(6)
    await waitFor(() => expect(row.result.current.total).toBe(9))
    expect(recentReads()).toBe(before.recent)
    expect(fullReads()).toBe(before.full + 1)
  })

  it('keeps the newest rows when the view closes, then reads the slice for itself', async () => {
    const row = mountRow(client)
    await waitFor(() => expect(row.result.current.total).toBe(8))
    const home = mountAgentHome()
    await waitFor(() => expect(home.result.current.isSuccess).toBe(true))
    server = [{ id: 'new', agentSlug: 'agent-1', name: 'New' }, ...server]
    await client.invalidateQueries({ queryKey: ['sessions', 'agent-1'] })
    await waitFor(() => expect(ids(row.result.current.recent.data)?.[0]).toBe('new'))
    const recentBefore = recentReads()

    // Hold the slice's own read so the rows shown before it lands can be checked.
    const replies: Array<(reply: unknown) => void> = []
    mockApiFetch.mockImplementation(() => new Promise((resolve) => replies.push(resolve)))
    home.unmount()

    await waitFor(() => expect(replies).toHaveLength(1))
    expect(recentReads()).toBe(recentBefore + 1)
    expect(ids(row.result.current.recent.data)?.[0]).toBe('new')
    expect(row.result.current.total).toBe(9)
    replies[0]({ ok: true, json: async () => ({ sessions: server.slice(0, 6), total: server.length }) })
    await waitFor(() => expect(row.result.current.recent.isSuccess).toBe(true))
    expect(ids(row.result.current.recent.data)?.[0]).toBe('new')
  })

  it('reads a slice with no rows yet, even beside a live full list', async () => {
    const home = mountAgentHome()
    await waitFor(() => expect(home.result.current.isSuccess).toBe(true))
    // The full list's read did not make a slice no row asked for.
    expect(client.getQueryData(['sessions', 'agent-1', 'recent', 6])).toBeUndefined()

    const row = mountRow(client)
    await waitFor(() => expect(row.result.current.recent.data).toHaveLength(6))
    expect(recentReads()).toBe(1)
    expect(row.result.current.total).toBe(8)
  })
})

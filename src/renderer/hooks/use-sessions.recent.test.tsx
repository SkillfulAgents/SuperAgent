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
import { useRecentSessions, useSessionTotal } from './use-sessions'

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
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agent-1/sessions?limit=6&with_total=true')
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

  it('reports no total for a server that answers the limited rows alone', async () => {
    client.setQueryData(['session-total', 'agent-1'], 9)
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => rows(6) })

    const { result } = mountRow(client)
    await waitFor(() => expect(result.current.recent.isSuccess).toBe(true))

    expect(result.current.recent.data).toHaveLength(6)
    await waitFor(() => expect(result.current.total).toBeUndefined())
  })
})

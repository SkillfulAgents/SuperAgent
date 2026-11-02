// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { usePendingUserRequests } from './use-pending-user-requests'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: [] }),
  resolveRouteAgentId: (slug: string) => slug,
}))

const validEnvelope = {
  id: 'req-1',
  kind: 'secret',
  scope: { agentSlug: 'agent-1', sessionId: 's-1' },
  blocking: true,
  autoApproved: false,
  payload: { secretName: 'API_KEY' },
}

function okResponse(requests: unknown[]) {
  return { ok: true, json: async () => ({ requests }) }
}

describe('usePendingUserRequests', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5000 } },
    })
  })

  afterEach(() => {
    cleanup()
    queryClient.clear()
  })

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('fetches the scoped snapshot and returns the parsed envelopes', async () => {
    mockApiFetch.mockResolvedValue(okResponse([validEnvelope]))

    const { result } = renderHook(() => usePendingUserRequests('agent-1', 's-1'), { wrapper })

    await waitFor(() => expect(result.current.data).toHaveLength(1))
    expect(result.current.data?.[0].id).toBe('req-1')
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agent-1/pending-requests?sessionId=s-1', { signal: expect.any(AbortSignal) })
  })

  it('does not fetch for an unsent draft and starts when its session id arrives', async () => {
    mockApiFetch.mockResolvedValue(okResponse([validEnvelope]))
    const { result, rerender } = renderHook(
      ({ sessionId }) => usePendingUserRequests('agent-1', sessionId),
      { wrapper, initialProps: { sessionId: null as string | null } },
    )
    expect(mockApiFetch).not.toHaveBeenCalled()
    rerender({ sessionId: 's-1' })
    await waitFor(() => expect(result.current.data).toHaveLength(1))
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agent-1/pending-requests?sessionId=s-1', { signal: expect.any(AbortSignal) })
  })

  it('omits the sessionId query for the agent-wide view', async () => {
    mockApiFetch.mockResolvedValue(okResponse([]))

    const { result } = renderHook(() => usePendingUserRequests('agent-1'), { wrapper })

    await waitFor(() => expect(result.current.data).toEqual([]))
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agent-1/pending-requests', { signal: expect.any(AbortSignal) })
  })

  it.each([
    { event: 'created', before: [], after: [validEnvelope] },
    { event: 'resolved', before: [validEnvelope], after: [] },
  ])('refetches when a request $event event overtakes the first snapshot', async ({ before, after }) => {
    let finishFirst!: (value: ReturnType<typeof okResponse>) => void
    mockApiFetch.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
    mockApiFetch.mockResolvedValue(okResponse(after))
    const { result } = renderHook(() => usePendingUserRequests('agent-1', 's-1'), { wrapper })
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1))

    await act(async () => {
      // The server has changed, but the first HTTP response still holds the
      // earlier snapshot. SSE must cause a fresh read now.
      const refresh = queryClient.invalidateQueries({ queryKey: ['pending-user-requests'] })
      finishFirst(okResponse(before))
      await refresh
    })

    await waitFor(() => expect(result.current.data).toEqual(after))
    expect(mockApiFetch).toHaveBeenCalledTimes(2)
    expect(mockApiFetch.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('a failed fetch is an ERROR that keeps the last snapshot — never an empty success', async () => {
    // Returning [] on !res.ok would cache "no requests" as truth: every card
    // vanishes (capability reviews have no fallback source) and the activity
    // indicator flips to "Working..." while the agent is actually blocked,
    // until the next poll tick. An error keeps data and retries instead.
    mockApiFetch.mockResolvedValueOnce(okResponse([validEnvelope]))

    // Destructure INSIDE render, like production consumers: React Query only
    // notifies on changes to properties a render has already read.
    const { result } = renderHook(
      () => {
        const { data, isError, refetch } = usePendingUserRequests('agent-1', 's-1')
        return { data, isError, refetch }
      },
      { wrapper },
    )
    await waitFor(() => expect(result.current.data).toHaveLength(1))

    mockApiFetch.mockResolvedValueOnce({ ok: false, status: 500 })
    await act(async () => {
      await result.current.refetch()
    })

    expect(mockApiFetch).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toHaveLength(1)
    expect(result.current.data?.[0].id).toBe('req-1')
  })
})

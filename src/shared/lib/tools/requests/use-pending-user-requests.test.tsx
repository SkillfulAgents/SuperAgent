// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
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
      defaultOptions: { queries: { retry: false } },
    })
  })

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('fetches the scoped snapshot and returns the parsed envelopes', async () => {
    mockApiFetch.mockResolvedValue(okResponse([validEnvelope]))

    const { result } = renderHook(() => usePendingUserRequests('agent-1', 's-1'), { wrapper })

    await waitFor(() => expect(result.current.data).toHaveLength(1))
    expect(result.current.data?.[0].id).toBe('req-1')
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agent-1/pending-requests?sessionId=s-1')
  })

  it('omits the sessionId query for the agent-wide view', async () => {
    mockApiFetch.mockResolvedValue(okResponse([]))

    const { result } = renderHook(() => usePendingUserRequests('agent-1'), { wrapper })

    await waitFor(() => expect(result.current.data).toEqual([]))
    expect(mockApiFetch).toHaveBeenCalledWith('/api/agents/agent-1/pending-requests')
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

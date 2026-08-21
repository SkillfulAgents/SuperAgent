// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PropsWithChildren } from 'react'
import type { ApiAgent } from '@shared/lib/types/api'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  track: vi.fn(),
}))

vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: mocks.track }),
}))
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({}) }))

import { useAgent, useAgents, useStartAgent } from './use-agents'

const stoppedAgent: ApiAgent = {
  slug: 'agent-a',
  displaySlug: 'agent-a',
  name: 'Agent A',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  status: 'stopped',
  containerPort: null,
  dashboards: [{ slug: 'sales', name: 'Sales' }],
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('useStartAgent', () => {
  let queryClient: QueryClient
  let serverAgent: ApiAgent

  beforeEach(() => {
    vi.clearAllMocks()
    serverAgent = { ...stoppedAgent }
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/agents/agent-a/start' && init?.method === 'POST') {
        serverAgent = { ...serverAgent, status: 'running', containerPort: 3456 }
        return jsonResponse(serverAgent)
      }
      if (url === '/api/agents') return jsonResponse([serverAgent])
      if (url === '/api/agents/agent-a') return jsonResponse(serverAgent)
      throw new Error(`Unexpected request: ${url}`)
    })
  })

  function wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }

  function useStartHarness() {
    const list = useAgents()
    const detail = useAgent('agent-a')
    const start = useStartAgent()
    return { list, detail, start }
  }

  it('publishes the running status to list and detail consumers after health succeeds', async () => {
    const { result } = renderHook(useStartHarness, { wrapper })
    await waitFor(() => expect(result.current.detail.data?.status).toBe('stopped'))
    mocks.apiFetch.mockClear()

    await act(async () => {
      await result.current.start.mutateAsync('agent-a')
    })

    await waitFor(() => {
      expect(result.current.list.data?.[0]).toMatchObject({ status: 'running', containerPort: 3456 })
      expect(result.current.detail.data).toMatchObject({ status: 'running', containerPort: 3456 })
    })
    expect(mocks.track).toHaveBeenCalledWith('agent_started')
    expect(mocks.apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/agents/agent-a/start'])
  })

  it('does not record speculative warm starts as user starts', async () => {
    const { result } = renderHook(() => useStartAgent(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ slug: 'agent-a', source: 'warm-start' })
    })

    expect(mocks.track).not.toHaveBeenCalled()
  })
})

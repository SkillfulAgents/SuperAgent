// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppQueryClient } from '@renderer/lib/query-client'
import { HttpError } from '@renderer/lib/http-error'
import { useSession } from './use-sessions'

const mockApiJson = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(),
  apiJson: (...args: unknown[]) => mockApiJson(...args),
}))

vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => vi.fn(),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: [] }),
  resolveRouteAgentId: (slug: string) => slug,
}))

function renderSession() {
  const queryClient = createAppQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return renderHook(() => useSession('session-1', 'agent-1'), { wrapper })
}

describe('useSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports a deleted session on the first 404, without retrying', async () => {
    mockApiJson.mockRejectedValue(new HttpError(404))
    const { result } = renderSession()

    await waitFor(() => expect(result.current.error).toBeInstanceOf(HttpError), { timeout: 500 })
    expect(mockApiJson).toHaveBeenCalledOnce()
  })

  it('still retries a server error', async () => {
    mockApiJson.mockRejectedValueOnce(new HttpError(503)).mockResolvedValueOnce({ id: 'session-1', name: 'Plan the launch' })
    const { result } = renderSession()

    await waitFor(() => expect(result.current.data?.name).toBe('Plan the launch'), { timeout: 3000 })
    expect(mockApiJson).toHaveBeenCalledTimes(2)
  })
})

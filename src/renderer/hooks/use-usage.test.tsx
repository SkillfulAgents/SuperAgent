// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUsageData } from './use-usage'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response
}

describe('useUsageData', () => {
  let queryClient: QueryClient
  let wrapper: ({ children }: { children: ReactNode }) => ReactNode

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    mockApiFetch.mockResolvedValue(jsonResponse({ daily: [] }))
  })

  it('loads automatically and uses the query key to fetch changed filters', async () => {
    const { result, rerender } = renderHook(
      ({ days, global }) => useUsageData(days, global),
      { wrapper, initialProps: { days: 7, global: false } },
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockApiFetch).toHaveBeenCalledOnce()
    expect(mockApiFetch).toHaveBeenLastCalledWith('/api/usage?days=7')

    rerender({ days: 14, global: true })
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2))
    expect(mockApiFetch).toHaveBeenLastCalledWith('/api/usage?days=14&global=true')
  })
})

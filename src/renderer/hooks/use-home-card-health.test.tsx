// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useHomeCardHealth } from './use-home-card-health'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const TZ = new Date().getTimezoneOffset()

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })}>
      {children}
    </QueryClientProvider>
  )
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

describe('home card health hook', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches and validates the single card-health batch', async () => {
    const payload = {
      days: 14,
      generatedAt: '2026-07-30T12:00:00.000Z',
      crons: [],
      webhooks: [],
      cronByTaskId: {},
      webhookByTriggerId: {},
    }
    mockApiFetch.mockResolvedValue(jsonResponse(payload))

    const { result } = renderHook(() => useHomeCardHealth(true), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/home-card-health?days=14&tz=${TZ}`)
    expect(result.current.data).toEqual(payload)
  })

  it('does not fetch while Card view is inactive', () => {
    const { result } = renderHook(() => useHomeCardHealth(false), { wrapper })

    expect(result.current.fetchStatus).toBe('idle')
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('rejects graph-shaped or malformed data at the card boundary', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({
      accountLinks: [],
      invocations: [],
    }))

    const { result } = renderHook(() => useHomeCardHealth(true), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })
})

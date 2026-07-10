// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useAgentActivityStats, useConnectionActivityStats } from './use-activity-stats'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })}>{children}</QueryClientProvider>
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

describe('activity hooks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches the encoded agent-scoped endpoint and returns typed chart maps', async () => {
    const payload = {
      days: 14,
      cronByTaskId: { task: [] },
      webhookByTriggerId: { hook: [] },
      connectionById: { 'account-a': [] },
    }
    mockApiFetch.mockResolvedValue(jsonResponse(payload))

    const { result } = renderHook(() => useAgentActivityStats('agent/name'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockApiFetch).toHaveBeenCalledWith('/api/activity/agents/agent%2Fname?days=14')
    expect(result.current.data).toEqual(payload)
  })

  it('does not fetch until an agent id exists', () => {
    const { result } = renderHook(() => useAgentActivityStats(null), { wrapper })
    expect(result.current.fetchStatus).toBe('idle')
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('fetches global connection activity independently from agent caches', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ days: 14, connectionById: {} }))

    const { result } = renderHook(() => useConnectionActivityStats(), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockApiFetch).toHaveBeenCalledWith('/api/activity/connections?days=14')
  })

  it('surfaces transport failures without manufacturing zero data', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({}, false))

    const { result } = renderHook(() => useConnectionActivityStats(), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })
})

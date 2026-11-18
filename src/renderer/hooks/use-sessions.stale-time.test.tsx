// @vitest-environment jsdom
/**
 * The session-list hooks take an optional staleTime. Left out, the client's
 * default must apply: an explicit `staleTime: undefined` would replace it with
 * 0, and every new mount would read the agent's full session list again.
 */
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotableSessions, useSessions } from './use-sessions'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  apiJson: vi.fn(),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useResolvedAgentId: (slug?: string) => slug ?? null,
  resolveRouteAgentId: (slug: string) => slug,
}))

function clientWithDefaultStaleTime() {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: false } } })
}

function mount<T extends { isSuccess: boolean }>(client: QueryClient, useHook: () => T) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  return renderHook(useHook, { wrapper })
}

describe('session list staleness', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => [] })
  })

  it.each([
    ['full list', () => useSessions('agent-1'), '/api/agents/agent-1/sessions'],
    ['notable slice', () => useNotableSessions('agent-1'), '/api/agents/agent-1/sessions?notable=true&limit=25'],
  ])('a %s mounted again inside the default staleTime is read once', async (_name, useHook, url) => {
    const client = clientWithDefaultStaleTime()
    const first = mount(client, useHook)
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true))
    first.unmount()

    const second = mount(client, useHook)
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true))

    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockApiFetch).toHaveBeenCalledWith(url)
  })

  it('an explicit staleTime still applies', async () => {
    const client = clientWithDefaultStaleTime()
    const first = mount(client, () => useSessions('agent-1', { staleTime: 0 }))
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true))
    first.unmount()

    mount(client, () => useSessions('agent-1', { staleTime: 0 }))

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2))
  })
})

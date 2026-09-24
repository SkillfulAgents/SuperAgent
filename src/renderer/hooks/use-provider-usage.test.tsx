// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useProviderUsage } from './use-provider-usage'
import { connectionInfoSchema } from '@shared/lib/llm-provider/connection-schema'
const state = vi.hoisted(() => ({ userId: 'alice', fetch: vi.fn() }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ user: { id: state.userId } }) }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: state.fetch }))
const connection = connectionInfoSchema.parse({ id: 'global', name: 'Platform', provider: 'platform', supportsUsage: true, userId: null, ownerName: null, managed: true, isConfigured: true, catalog: [], modelOverrides: [], defaultModel: null, browserModel: null, dashboardModel: null, canManage: false, canDelete: false })
beforeEach(() => { state.userId = 'alice'; state.fetch.mockReset() })
function setup(initial = connection) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, ...renderHook(({ value }) => useProviderUsage(value), { wrapper, initialProps: { value: initial } }) }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('usage reads on view', () => {
  it('separates Platform query caches by signed-in member and hides a failed refresh', async () => {
    state.fetch.mockImplementation(async () => new Response(JSON.stringify({ status: 'available', observedAt: new Date().toISOString(), limits: [{ kind: 'balance', id: 'seat', label: 'Seat', remaining: state.userId === 'alice' ? 10 : 20, unit: 'USD' }] })))
    const { result, rerender, client } = setup()
    await waitFor(() => expect(result.current.data?.limits[0]).toMatchObject({ remaining: 10 }))
    state.userId = 'bob'; rerender({ value: connection })
    expect(result.current.data).toBeUndefined()
    await waitFor(() => expect(result.current.data?.limits[0]).toMatchObject({ remaining: 20 }))
    state.fetch.mockResolvedValue(new Response(JSON.stringify({ status: 'unavailable', observedAt: new Date().toISOString(), limits: [] })))
    await client.invalidateQueries({ queryKey: ['llm-provider-usage'] })
    await waitFor(() => expect(result.current.data?.status).toBe('unavailable'))
  })
  it('has no timer/focus polling and reuses fresh data when reopened', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval')
    state.fetch.mockResolvedValue(new Response(JSON.stringify({ status: 'available', observedAt: new Date().toISOString(), limits: [] })))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const first = renderHook(() => useProviderUsage(connection), { wrapper })
    await waitFor(() => expect(first.result.current.data?.status).toBe('available'))
    expect(intervals.mock.calls.filter(call => call[1] === 60_000)).toHaveLength(0)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(state.fetch).toHaveBeenCalledTimes(1)
    first.unmount()
    const reopened = renderHook(() => useProviderUsage(connection), { wrapper })
    expect(reopened.result.current.data?.status).toBe('available')
    expect(state.fetch).toHaveBeenCalledTimes(1)
    reopened.unmount()
    client.clear()
  })
  it('does not query unrelated personal accounts or keep their cached usage when disconnected', async () => {
    const { result, rerender } = setup({ ...connection, userId: 'bob' })
    expect(state.fetch).not.toHaveBeenCalled()
    expect(result.current.data).toBeUndefined()
    rerender({ value: { ...connection, isConfigured: false } })
    expect(state.fetch).not.toHaveBeenCalled()
    expect(result.current.data).toBeUndefined()
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useReconnectLocalVolume } from './use-volume-definitions'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const invalidated = vi.spyOn(client, 'invalidateQueries')
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, invalidated, wrapper }
}

describe('choosing a drive’s folder again', () => {
  it('sends the pick, then refetches the drive and the agents whose restart prompt it changes', async () => {
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ success: true }))
    const { invalidated, wrapper } = setup()
    const { result } = renderHook(() => useReconnectLocalVolume(), { wrapper })
    await act(() => result.current.mutateAsync({ id: 'v1', config: { path: '/notes', bookmark: 'Ym0y' } }))
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/volume-definitions/v1/reconnect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/notes', bookmark: 'Ym0y' }),
    })
    expect(invalidated.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ['volume-definitions'], ['mounts'], ['volume-files', 'v1'], ['agents'],
    ])
  })
  it('refetches nothing when the pick is refused', async () => {
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ error: 'Choose this drive’s own folder' }, { status: 400 }))
    const { invalidated, wrapper } = setup()
    const { result } = renderHook(() => useReconnectLocalVolume(), { wrapper })
    await expect(act(() => result.current.mutateAsync({ id: 'v1', config: { path: '/elsewhere' } }))).rejects.toThrow('Choose this drive’s own folder')
    expect(invalidated).not.toHaveBeenCalled()
  })
})

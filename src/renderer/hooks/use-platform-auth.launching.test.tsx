// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/api/platform-auth') return { ok: true, json: async () => ({ connected: true, updatedAt: 't1' }) }
    if (path.endsWith('/initiate')) return { ok: true, json: async () => ({ loginUrl: 'https://platform.test/login' }) }
    return { ok: true, json: async () => ({}) }
  }),
}))

import { usePlatformConnect } from './use-platform-auth'

// Web mode: the login callback never arrives here (the deep link lands in the
// desktop app), so a saved token is the only thing that can end a launch.
describe('usePlatformConnect launching state in a browser window', () => {
  it('ends the launch when the stored token changes by any path', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => usePlatformConnect(), { wrapper })
    await waitFor(() => expect(result.current.isConnected).toBe(true))

    await act(async () => { await result.current.handleConnect() })
    expect(result.current.isLaunching).toBe(true)

    // An access key saved meanwhile: the status query carries a new updatedAt.
    act(() => { client.setQueryData(['platform-auth'], { connected: true, updatedAt: 't2' }) })
    await waitFor(() => expect(result.current.isLaunching).toBe(false))
  })
})

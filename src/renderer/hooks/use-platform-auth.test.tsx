// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { usePlatformConnect } from './use-platform-auth'

const apiFetchMock = vi.fn()
const navigateMock = vi.fn()
const closeMock = vi.fn()

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

vi.mock('@renderer/lib/oauth-popup', () => ({
  prepareOAuthPopup: () => ({ navigate: navigateMock, close: closeMock }),
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useUpdateSettings: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
}))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function mockApiFetch(overrides: { initiateOk?: boolean; connected?: boolean } = {}) {
  const { initiateOk = true, connected = true } = overrides
  apiFetchMock.mockImplementation((url: string) => {
    if (url === '/api/platform-auth') {
      return Promise.resolve({ ok: true, json: async () => ({ connected, platformBaseUrl: 'https://platform.test' }) })
    }
    if (url === '/api/platform-auth/initiate') {
      return initiateOk
        ? Promise.resolve({ ok: true, json: async () => ({ loginUrl: 'https://platform.test/login', platformBaseUrl: 'https://platform.test' }) })
        : Promise.resolve({ ok: false, json: async () => ({ error: 'boom' }) })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

function revokeCalls() {
  return apiFetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('/revoke'))
}

describe('usePlatformConnect.handleConnect', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    navigateMock.mockReset()
    closeMock.mockReset()
  })

  it('does not revoke the existing key when reconnecting (abandoned-login split-brain fix)', async () => {
    mockApiFetch({ connected: true })

    const { result } = renderHook(() => usePlatformConnect(), { wrapper })
    await waitFor(() => expect(result.current.isConnected).toBe(true))

    await act(async () => {
      await result.current.handleConnect()
    })

    expect(revokeCalls()).toHaveLength(0)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/platform-auth/initiate', expect.objectContaining({ method: 'POST' }))
    expect(navigateMock).toHaveBeenCalledWith('https://platform.test/login')
  })

  it('does not revoke when connecting fresh either', async () => {
    mockApiFetch({ connected: false })

    const { result } = renderHook(() => usePlatformConnect(), { wrapper })
    await waitFor(() => expect(result.current.isLoadingPlatformAuth).toBe(false))

    await act(async () => {
      await result.current.handleConnect()
    })

    expect(revokeCalls()).toHaveLength(0)
    expect(navigateMock).toHaveBeenCalledWith('https://platform.test/login')
  })

  it('closes the popup and surfaces an error when initiate fails', async () => {
    mockApiFetch({ connected: true, initiateOk: false })

    const { result } = renderHook(() => usePlatformConnect(), { wrapper })
    await waitFor(() => expect(result.current.isConnected).toBe(true))

    await act(async () => {
      await result.current.handleConnect()
    })

    expect(revokeCalls()).toHaveLength(0)
    expect(closeMock).toHaveBeenCalled()
    expect(navigateMock).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.error).toBe('boom'))
  })
})

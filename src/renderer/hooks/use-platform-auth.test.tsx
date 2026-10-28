// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { fakeLoginWindow } from '@renderer/test/fake-login-window'
import { usePlatformConnect } from './use-platform-auth'
import { LOGIN_WINDOW_CANCEL_DELAY_MS } from './use-login-window'

const apiFetchMock = vi.fn()

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))

vi.mock('@renderer/hooks/use-settings', () => ({
  useUpdateSettings: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
}))

function renderConnect() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(() => usePlatformConnect(), { wrapper })
}

function mockApiFetch(overrides: { initiateOk?: boolean; connected?: boolean } = {}) {
  const { initiateOk = true, connected = true } = overrides
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/platform-auth') {
      return { ok: true, json: async () => ({ connected, platformBaseUrl: 'https://platform.test' }) }
    }
    if (url === '/api/platform-auth/initiate') {
      return initiateOk
        ? { ok: true, json: async () => ({ loginUrl: 'https://platform.test/login' }) }
        : { ok: false, json: async () => ({ error: 'boom' }) }
    }
    throw new Error(`Unexpected API call: ${url}`)
  })
}

function expectNoRevoke() {
  expect(apiFetchMock.mock.calls.filter(([url]) => url === '/api/platform-auth/revoke')).toHaveLength(0)
}

describe('usePlatformConnect.handleConnect', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    fakeLoginWindow.prepare.mockClear()
    fakeLoginWindow.navigate.mockReset()
    fakeLoginWindow.close.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the existing key when reconnecting without completing login', async () => {
    mockApiFetch()
    const { result } = renderConnect()
    await waitFor(() => expect(result.current.isConnected).toBe(true))

    await act(async () => { await result.current.handleConnect() })

    expectNoRevoke()
    expect(apiFetchMock).toHaveBeenCalledWith('/api/platform-auth/initiate', { method: 'POST' })
    expect(fakeLoginWindow.navigate).toHaveBeenCalledWith('https://platform.test/login')
    expect(result.current.isLaunching).toBe(true)
    expect(result.current.isConnected).toBe(true)
  })

  it('opens login without revoking when connecting fresh', async () => {
    mockApiFetch({ connected: false })
    const { result } = renderConnect()
    await waitFor(() => expect(result.current.isLoadingPlatformAuth).toBe(false))

    await act(async () => { await result.current.handleConnect() })

    expectNoRevoke()
    expect(fakeLoginWindow.navigate).toHaveBeenCalledWith('https://platform.test/login')
  })

  it('closes the popup and surfaces an initiate error without revoking the key', async () => {
    mockApiFetch({ initiateOk: false })
    const { result } = renderConnect()
    await waitFor(() => expect(result.current.isConnected).toBe(true))

    await act(async () => { await result.current.handleConnect() })

    expectNoRevoke()
    expect(fakeLoginWindow.close).toHaveBeenCalledTimes(1)
    expect(fakeLoginWindow.navigate).not.toHaveBeenCalled()
    expect(result.current.error).toBe('boom')
    expect(result.current.isLaunching).toBe(false)
    expect(result.current.isConnected).toBe(true)
  })

  it('closes the popup and preserves the key when navigation fails', async () => {
    mockApiFetch()
    fakeLoginWindow.navigate.mockRejectedValueOnce(new Error('Unable to open browser'))
    const { result } = renderConnect()
    await waitFor(() => expect(result.current.isConnected).toBe(true))

    await act(async () => { await result.current.handleConnect() })

    expectNoRevoke()
    expect(fakeLoginWindow.close).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBe('Unable to open browser')
    expect(result.current.isLaunching).toBe(false)
    expect(result.current.isConnected).toBe(true)
  })

  it('cancels an opened login without revoking the existing key', async () => {
    mockApiFetch()
    const { result } = renderConnect()
    await waitFor(() => expect(result.current.isConnected).toBe(true))
    vi.useFakeTimers()
    await act(async () => { await result.current.handleConnect() })
    act(() => { vi.advanceTimersByTime(LOGIN_WINDOW_CANCEL_DELAY_MS) })
    expect(result.current.canCancel).toBe(true)

    act(() => { result.current.cancelConnect() })

    expectNoRevoke()
    expect(fakeLoginWindow.close).toHaveBeenCalledTimes(1)
    expect(result.current.isLaunching).toBe(false)
    expect(result.current.canCancel).toBe(false)
    expect(result.current.isConnected).toBe(true)
  })

  it('drops a pending initiate response after cancellation without revoking the key', async () => {
    mockApiFetch()
    const { result } = renderConnect()
    await waitFor(() => expect(result.current.isConnected).toBe(true))
    let release!: (response: unknown) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    let launch!: Promise<void>
    act(() => { launch = result.current.handleConnect() })
    await waitFor(() => expect(release).toBeDefined())

    act(() => { result.current.cancelConnect() })
    release({ ok: true, json: async () => ({ loginUrl: 'https://platform.test/login' }) })
    await act(async () => { await launch })

    expectNoRevoke()
    expect(fakeLoginWindow.navigate).not.toHaveBeenCalled()
    expect(fakeLoginWindow.close).toHaveBeenCalledTimes(1)
    expect(result.current.isLaunching).toBe(false)
    expect(result.current.isConnected).toBe(true)
  })

  it('closes an abandoned login on unmount without revoking the existing key', async () => {
    mockApiFetch()
    const { result, unmount } = renderConnect()
    await waitFor(() => expect(result.current.isConnected).toBe(true))
    await act(async () => { await result.current.handleConnect() })

    unmount()

    expectNoRevoke()
    expect(fakeLoginWindow.close).toHaveBeenCalledTimes(1)
  })
})

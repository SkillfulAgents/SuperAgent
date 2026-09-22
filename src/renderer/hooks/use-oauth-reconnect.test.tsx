// @vitest-environment jsdom
import { fakeLoginWindow } from '@renderer/test/fake-login-window'
import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOAuthReconnect } from './use-oauth-reconnect'

const mockApiFetch = vi.fn()
let oauthCallback: ((params: {
  connectionId?: string | null
  status?: string | null
  toolkit?: string | null
  error?: string | null
}) => void) | undefined

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))


describe('useOAuthReconnect', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    mockApiFetch.mockReset()
    fakeLoginWindow.navigate.mockReset().mockResolvedValue(undefined)
    fakeLoginWindow.close.mockReset()
    oauthCallback = undefined
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    window.electronAPI = {
      onOAuthCallback: vi.fn((callback) => {
        oauthCallback = callback
        return vi.fn()
      }),
    } as unknown as Window['electronAPI']
  })

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }

  it('returns true only after the Electron completion endpoint succeeds', async () => {
    mockApiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ connectionId: 'connection-new', redirectUrl: 'https://oauth.test' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useOAuthReconnect(), { wrapper })

    let reconnectPromise!: Promise<boolean>
    await act(async () => {
      reconnectPromise = result.current.reconnect('account-1', 'gmail')
    })
    await waitFor(() => expect(oauthCallback).toBeTypeOf('function'))

    await act(async () => {
      oauthCallback?.({ connectionId: 'connection-new', toolkit: 'gmail' })
    })

    await expect(reconnectPromise).resolves.toBe(true)
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/connected-accounts/complete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          connectionId: 'connection-new',
          toolkit: 'gmail',
          reconnectAccountId: 'account-1',
        }),
      }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pending-user-requests'] })
  })

  it('settles only on its own connection, not an earlier sign-in that ends while it waits', async () => {
    mockApiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ connectionId: 'conn-B', redirectUrl: 'https://oauth.test' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
    const { result } = renderHook(() => useOAuthReconnect(), { wrapper })

    let reconnectPromise!: Promise<boolean>
    await act(async () => { reconnectPromise = result.current.reconnect('account-B', 'gmail') })
    await waitFor(() => expect(oauthCallback).toBeTypeOf('function'))

    // A cancelled sign-in for the same service finishes in the external browser.
    await act(async () => { oauthCallback?.({ connectionId: 'conn-A', toolkit: 'gmail' }) })
    // A failure that names no connection cannot be traced to this reconnect either.
    await act(async () => { oauthCallback?.({ connectionId: null, status: 'failed', toolkit: 'gmail' }) })
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(result.current.pendingAccountId).toBe('account-B')

    await act(async () => { oauthCallback?.({ connectionId: 'conn-B', toolkit: 'gmail' }) })
    await expect(reconnectPromise).resolves.toBe(true)
    expect(mockApiFetch).toHaveBeenLastCalledWith('/api/connected-accounts/complete', expect.objectContaining({
      body: JSON.stringify({ connectionId: 'conn-B', toolkit: 'gmail', reconnectAccountId: 'account-B' }),
    }))
  })

  it('returns false and leaves the request pending when OAuth completion fails', async () => {
    mockApiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ connectionId: 'connection-bad', redirectUrl: 'https://oauth.test' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'failed' }), { status: 500 }))
    const { result } = renderHook(() => useOAuthReconnect(), { wrapper })

    let reconnectPromise!: Promise<boolean>
    await act(async () => {
      reconnectPromise = result.current.reconnect('account-1', 'gmail')
    })
    await waitFor(() => expect(oauthCallback).toBeTypeOf('function'))

    await act(async () => {
      oauthCallback?.({ connectionId: 'connection-bad', toolkit: 'gmail' })
    })

    await expect(reconnectPromise).resolves.toBe(false)
  })

  it('supersedes a reconnect still waiting, so it cannot close the next one\'s window', async () => {
    mockApiFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ redirectUrl: 'https://oauth.test' }), { status: 200 }))
    const { result } = renderHook(() => useOAuthReconnect(), { wrapper })

    let first!: Promise<boolean>
    await act(async () => { first = result.current.reconnect('account-1', 'gmail') })
    await waitFor(() => expect(oauthCallback).toBeTypeOf('function'))

    await act(async () => { void result.current.reconnect('account-2', 'github') })
    await expect(first).resolves.toBe(false)

    // Only the second reconnect's own open() closed a window (the first's).
    expect(fakeLoginWindow.close).toHaveBeenCalledTimes(1)
    expect(result.current.pendingAccountId).toBe('account-2')
  })

  it('keeps the result of a reconnect whose completion is in flight when the next one starts', async () => {
    let resolveComplete!: (res: Response) => void
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/connected-accounts/complete') {
        return new Promise<Response>((resolve) => { resolveComplete = resolve })
      }
      return new Response(JSON.stringify({ connectionId: 'connection-new', redirectUrl: 'https://oauth.test' }), { status: 200 })
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useOAuthReconnect(), { wrapper })

    let first!: Promise<boolean>
    await act(async () => { first = result.current.reconnect('account-1', 'gmail') })
    await waitFor(() => expect(oauthCallback).toBeTypeOf('function'))
    await act(async () => { oauthCallback?.({ connectionId: 'connection-new', toolkit: 'gmail' }) })

    await act(async () => { void result.current.reconnect('account-2', 'github') })
    fakeLoginWindow.close.mockClear()
    await act(async () => { resolveComplete(new Response(JSON.stringify({ success: true }), { status: 200 })) })

    await expect(first).resolves.toBe(true)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['connected-accounts'] })
    // The second reconnect's window and pending state are untouched.
    expect(fakeLoginWindow.close).not.toHaveBeenCalled()
    expect(result.current.pendingAccountId).toBe('account-2')
  })
})

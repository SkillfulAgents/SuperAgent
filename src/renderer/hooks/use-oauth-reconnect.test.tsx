// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOAuthReconnect } from './use-oauth-reconnect'

const mockApiFetch = vi.fn()
const mockNavigate = vi.fn()
const mockClose = vi.fn()
let oauthCallback: ((params: {
  connectionId?: string | null
  status?: string | null
  toolkit?: string | null
  error?: string | null
}) => void) | undefined

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

vi.mock('@renderer/lib/oauth-popup', () => ({
  prepareOAuthPopup: () => ({ navigate: mockNavigate, close: mockClose }),
}))

vi.mock('@renderer/hooks/use-delayed-oauth-abort', () => ({
  useDelayedOAuthAbort: () => false,
}))

describe('useOAuthReconnect', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    mockApiFetch.mockReset()
    mockNavigate.mockReset().mockResolvedValue(undefined)
    mockClose.mockReset()
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ redirectUrl: 'https://oauth.test' }), { status: 200 }))
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

  // Shopify saves the grant under the store the merchant authorized. When that is a
  // different account, this one is still lapsed and the card must stay open.
  it('returns false when the grant was saved under another account', async () => {
    mockApiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ redirectUrl: 'https://oauth.test' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ account: { id: 'other-account' } }), { status: 200 }))
    const { result } = renderHook(() => useOAuthReconnect(), { wrapper })

    let reconnectPromise!: Promise<boolean>
    await act(async () => {
      reconnectPromise = result.current.reconnect('account-1', 'shopify')
    })
    await waitFor(() => expect(oauthCallback).toBeTypeOf('function'))

    await act(async () => {
      oauthCallback?.({ connectionId: 'connection-new', toolkit: 'shopify' })
    })

    await expect(reconnectPromise).resolves.toBe(false)
  })

  // Same rule on the web host, where the callback carries the saved account id.
  it('returns false on the web when the grant was saved under another account', async () => {
    window.electronAPI = undefined
    mockApiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ redirectUrl: 'https://oauth.test' }), { status: 200 }),
    )
    const { result } = renderHook(() => useOAuthReconnect(), { wrapper })

    let reconnectPromise!: Promise<boolean>
    await act(async () => {
      reconnectPromise = result.current.reconnect('account-1', 'shopify')
    })

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'oauth-callback', success: true, accountId: 'other-account' },
      }))
    })

    await expect(reconnectPromise).resolves.toBe(false)
  })

  it('returns false and leaves the request pending when OAuth completion fails', async () => {
    mockApiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ redirectUrl: 'https://oauth.test' }), { status: 200 }))
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
})

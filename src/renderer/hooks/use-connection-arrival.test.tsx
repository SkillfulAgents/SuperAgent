// @vitest-environment jsdom
import { StrictMode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnectionArrival } from './use-connection-arrival'

const router = vi.hoisted(() => ({ navigate: vi.fn(), search: {} as Record<string, string> }))
const mockInitiate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => router.navigate,
  useSearch: () => router.search,
}))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({
  useInitiateConnection: () => ({ mutateAsync: mockInitiate }),
}))

describe('useConnectionArrival (Shopify handoff to Connections)', () => {
  const SHOP = 'gamut-dev.myshopify.com'
  const assign = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    router.search = { shop: SHOP }
    Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true })
  })

  // A deeplink opens a browser tab with no click to open a popup from, so the
  // grant takes over the tab with the store pre-filled.
  it('connects a store that is not connected yet, in this tab', async () => {
    mockInitiate.mockResolvedValue({ redirectUrl: 'https://backend.composio.dev/api/v3/s/abc' })
    // StrictMode replays the effect before the URL change renders; the grant must still start once.
    renderHook(() => useConnectionArrival(), { wrapper: StrictMode })

    expect(mockInitiate).toHaveBeenCalledWith(expect.objectContaining({ providerSlug: 'shopify', identity: SHOP }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://backend.composio.dev/api/v3/s/abc'))
    // The store leaves the URL before the grant starts, so a remount cannot start another.
    const { search, replace } = router.navigate.mock.calls[0][0]
    expect(search({ shop: SHOP })).toEqual({ shop: undefined })
    expect(replace).toBe(true)
    expect(router.navigate.mock.invocationCallOrder[0]).toBeLessThan(mockInitiate.mock.invocationCallOrder[0])
    expect(mockInitiate).toHaveBeenCalledTimes(1)
  })

  // The connect route, not the renderer, knows which account a store belongs to.
  it('opens the account the connect route returns instead of starting a grant', async () => {
    mockInitiate.mockResolvedValue({ accountId: 'shop-acc' })
    renderHook(() => useConnectionArrival())

    await waitFor(() => expect(router.navigate).toHaveBeenCalledTimes(2))
    expect(assign).not.toHaveBeenCalled()
    const { search, replace } = router.navigate.mock.calls[1][0]
    expect(search({ connectionView: 'logs' })).toEqual({ detail: 'account-shop-acc', connectionView: undefined })
    expect(replace).toBe(true)
  })
})

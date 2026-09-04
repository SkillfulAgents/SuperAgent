// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BillingUpdatedHandler } from './billing-updated-handler'

describe('BillingUpdatedHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('invalidates the billing snapshot on the billing-updated deep link and unsubscribes on unmount', () => {
    let fire: (() => void) | undefined
    const unsubscribe = vi.fn()
    window.electronAPI = {
      onBillingUpdated: (cb: () => void) => {
        fire = cb
        return unsubscribe
      },
    } as unknown as typeof window.electronAPI
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    const { unmount } = render(
      <QueryClientProvider client={client}>
        <BillingUpdatedHandler />
      </QueryClientProvider>,
    )
    act(() => fire?.())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['platform-billing'] })

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('renders nothing and tolerates a preload without the bridge', () => {
    window.electronAPI = {} as unknown as typeof window.electronAPI
    const client = new QueryClient()
    const { container } = render(
      <QueryClientProvider client={client}>
        <BillingUpdatedHandler />
      </QueryClientProvider>,
    )
    expect(container.innerHTML).toBe('')
  })
})

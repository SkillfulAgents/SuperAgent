// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useBillingUpdatedListener } from './use-billing-updated'

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children)
  }
}

describe('useBillingUpdatedListener', () => {
  let billingUpdated: (() => void) | undefined

  beforeEach(() => {
    billingUpdated = undefined
    window.electronAPI = {
      onBillingUpdated: (callback) => {
        billingUpdated = callback
        return () => {}
      },
      flushPendingBillingUpdated: async () => false,
    } as typeof window.electronAPI
  })

  it('refreshes the active billing query after the dashboard handoff', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue()
    renderHook(() => useBillingUpdatedListener(), { wrapper: wrapper(client) })

    act(() => billingUpdated?.())

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['platform-billing'],
        refetchType: 'active',
      })
    })
  })

  it('coalesces deep-link, focus, and visibility signals', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue()
    renderHook(() => useBillingUpdatedListener(), { wrapper: wrapper(client) })

    act(() => {
      billingUpdated?.()
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1))
  })
})

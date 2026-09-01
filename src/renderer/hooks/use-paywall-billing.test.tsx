// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetch = vi.fn()

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

vi.mock('@renderer/lib/error-reporting', () => ({
  captureRendererException: vi.fn(),
}))

import { usePaywallBilling } from './use-paywall-billing'

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    children,
  )
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('usePaywallBilling', () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it('posts a top-up and invalidates billing', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ status: 'complete', amountCents: 2000, alreadyIssued: false }))
    const { result } = renderHook(() => usePaywallBilling(), { wrapper })

    await expect(result.current.topup(2000)).resolves.toBe(true)
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/platform-auth/billing/topup',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ amountCents: 2000 }),
      }),
    )
  })

  it('surfaces a declined top-up', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ error: 'Your card was declined.' }, 402))
    const { result } = renderHook(() => usePaywallBilling(), { wrapper })

    await expect(result.current.topup(2000)).resolves.toBe(false)
    await waitFor(() => {
      expect(result.current.error).toBe('Your card was declined.')
    })
  })
})

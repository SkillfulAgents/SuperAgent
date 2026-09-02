// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import React from 'react'

import { usePaywallCta } from './use-paywall-cta'
import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'

const platformAuth = {
  connected: true,
  platformBaseUrl: 'https://platform.example.com',
  orgId: 'org_123',
  role: 'member' as string | null,
}

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: platformAuth }),
}))

const billingState = {
  data: undefined as {
    connected: boolean
    billing?: {
      configured: boolean
      subscription: { status: string | null; paymentStatus?: string | null }
      seat: { balanceCents: number; startingBalanceCents: number } | null
      orgPool: { poolBalanceCents: number }
      hasPaymentMethod?: boolean
      access?: { allowed: boolean; reason: string }
    }
    stale?: boolean
  } | undefined,
  isLoading: false,
  isFetching: false,
  error: null as Error | null,
}

vi.mock('@renderer/hooks/use-billing-info', () => ({
  useBillingInfo: () => billingState,
}))

const PAYWALL: ProviderErrorPresentation = {
  severity: 'error',
  icon: 'info',
  message: '**You need more usage credit to continue** Subscribe or top up.',
  paywall: {},
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children)
  }
}

describe('usePaywallCta', () => {
  beforeEach(() => {
    platformAuth.role = 'member'
    billingState.data = {
      connected: true,
      billing: {
        configured: true,
        subscription: { status: 'active', paymentStatus: 'current' },
        seat: { balanceCents: 1250, startingBalanceCents: 2000 },
        orgPool: { poolBalanceCents: 5000 },
        hasPaymentMethod: true,
      },
    }
    billingState.isLoading = false
    billingState.isFetching = false
    billingState.error = null
  })

  it('routes members to ask an admin', async () => {
    const { result } = renderHook(() => usePaywallCta(PAYWALL), { wrapper: wrapper() })
    await waitFor(() => {
      expect(result.current.cta?.kind).toBe('ask_admin')
    })
  })

  it('shows the subscription CTA immediately while the billing snapshot loads', () => {
    platformAuth.role = 'owner'
    billingState.data = undefined
    billingState.isLoading = true
    const presentation: ProviderErrorPresentation = {
      ...PAYWALL,
      paywall: { subscriptionRequired: true },
    }

    const { result } = renderHook(() => usePaywallCta(presentation), { wrapper: wrapper() })

    expect(result.current.cta?.kind).toBe('subscribe')
    expect(result.current.loading).toBe(true)
  })

  it('keeps background billing refreshes visually silent', () => {
    billingState.isFetching = true

    const { result } = renderHook(() => usePaywallCta(PAYWALL), { wrapper: wrapper() })

    expect(result.current.loading).toBe(false)
  })
})

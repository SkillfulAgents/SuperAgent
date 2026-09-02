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
  role: 'owner' as string | null,
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
      autoReload?: {
        enabled: boolean
        thresholdCents: number | null
        topupAmountCents: number | null
      } | null
    }
  } | undefined,
  isLoading: false,
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
    platformAuth.role = 'owner'
    billingState.data = undefined
    billingState.isLoading = false
    billingState.error = null
  })

  it('subscribes when the 402 omitted the flag and billing has no plan', async () => {
    billingState.data = {
      connected: true,
      billing: {
        configured: true,
        subscription: { status: 'inactive' },
        seat: null,
        orgPool: { poolBalanceCents: 0 },
      },
    }
    const { result } = renderHook(() => usePaywallCta(PAYWALL), { wrapper: wrapper() })
    await waitFor(() => {
      expect(result.current.cta).toEqual({
        kind: 'subscribe',
        href: 'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
      })
    })
  })

  it('tops up when the 402 omitted the flag and billing has a plan plus a card', async () => {
    billingState.data = {
      connected: true,
      billing: {
        configured: true,
        subscription: { status: 'active' },
        seat: null,
        orgPool: { poolBalanceCents: 0 },
        hasPaymentMethod: true,
      },
    }
    const { result } = renderHook(() => usePaywallCta(PAYWALL), { wrapper: wrapper() })
    await waitFor(() => {
      expect(result.current.cta?.kind).toBe('topup')
      expect(result.current.details).toEqual({
        subscriptionStatus: 'active',
        paymentStatus: null,
        seatBalanceCents: null,
        orgPoolBalanceCents: 0,
        hasPaymentMethod: true,
        autoReload: undefined,
      })
    })
  })

  it('hides billing details from members', async () => {
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
    const { result } = renderHook(() => usePaywallCta(PAYWALL), { wrapper: wrapper() })
    await waitFor(() => {
      expect(result.current.cta?.kind).toBe('ask_admin')
      expect(result.current.details).toBeNull()
    })
  })

  it('prioritizes a payment failure and retains the full snapshot', async () => {
    billingState.data = {
      connected: true,
      billing: {
        configured: true,
        subscription: { status: 'active', paymentStatus: 'past_due' },
        seat: { balanceCents: 1250, startingBalanceCents: 2000 },
        orgPool: { poolBalanceCents: 5000 },
        hasPaymentMethod: true,
        autoReload: { enabled: true, thresholdCents: 1000, topupAmountCents: 5000 },
      },
    }
    const { result } = renderHook(() => usePaywallCta(PAYWALL), { wrapper: wrapper() })
    await waitFor(() => {
      expect(result.current.cta?.kind).toBe('manage_payment')
      expect(result.current.details?.autoReload?.enabled).toBe(true)
      expect(result.current.details?.seatBalanceCents).toBe(1250)
    })
  })
})

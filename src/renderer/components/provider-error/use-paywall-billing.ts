import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'

import { useBillingInfo } from '@renderer/hooks/use-billing-info'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { captureRendererException } from '@renderer/lib/error-reporting'

import { resolvePaywallCta, subscriptionRequiredFromBilling, type PaywallCta } from './paywall-cta'

export const PAYWALL_RECHECK_INTERVAL_MS = 5000

export interface PaywallBilling {
  cta: PaywallCta | null
  loading: boolean
  /** A fresh snapshot positively denies access: the composer can be withheld. */
  blocked: boolean
  /** A fresh snapshot allows access again (after this paywall appeared, if live): the card can go. */
  cleared: boolean
  recheck: () => void
}

function invalidateBillingSnapshot(queryClient: QueryClient, op: string): Promise<void> {
  return queryClient
    .invalidateQueries({ queryKey: ['platform-billing'], refetchType: 'active' })
    .then(() => undefined)
    .catch((error: unknown) => {
      console.warn('[Paywall] billing refresh failed:', error)
      captureRendererException(error, { tags: { area: 'paywall', op } })
    })
}

function useBillingRecheckPoll(enabled: boolean): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => {
      void invalidateBillingSnapshot(queryClient, 'recheck-poll')
    }, PAYWALL_RECHECK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [enabled, queryClient])
}

// `flagFrom402` is the proxy's subscription_required flag when the 402 body kept it;
// `billingHref` is the provider-resolved CTA link (presentation.href).
// A live 402 ignores a leftover `allowed` snapshot from a previous recovery.
// A persisted 402 (switch session after a top-up) trusts the current snapshot.
export function usePaywallBilling(
  flagFrom402: boolean | undefined,
  billingHref: string | null,
  live: boolean,
  poll = true,
): PaywallBilling {
  const { data: platformAuth } = usePlatformAuthStatus()
  const role = platformAuth?.role
  const billingQuery = useBillingInfo(Boolean(platformAuth?.connected))
  const queryClient = useQueryClient()

  const [seenAt] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    void invalidateBillingSnapshot(queryClient, 'refresh-on-mount')
  }, [live, queryClient])

  const billingError = billingQuery.error
  useEffect(() => {
    if (!billingError) return
    console.warn('[Paywall] billing snapshot fetch failed:', billingError)
    captureRendererException(billingError, { tags: { area: 'paywall', op: 'billing-info' } })
  }, [billingError])

  const snapshot = useMemo(() => {
    if (billingQuery.isLoading) {
      return { cta: null, loading: true, blocked: false, cleared: false }
    }
    const fresh = billingQuery.data?.stale !== true
    const billing = billingQuery.data?.billing
    const allowed = fresh ? billing?.access?.allowed : undefined
    return {
      cta: resolvePaywallCta({
        subscriptionRequired: flagFrom402 ?? subscriptionRequiredFromBilling(billing),
        role,
        hasPaymentMethod: billing?.hasPaymentMethod,
        paymentStatus: billing?.subscription.paymentStatus,
        billingHref,
      }),
      loading: false,
      blocked: allowed === false,
      cleared: allowed === true && (!live || billingQuery.dataUpdatedAt > seenAt),
    }
  }, [
    billingHref,
    billingQuery.data?.billing,
    billingQuery.data?.stale,
    billingQuery.dataUpdatedAt,
    billingQuery.isLoading,
    flagFrom402,
    live,
    role,
    seenAt,
  ])

  useBillingRecheckPoll(poll && !snapshot.cleared)

  const recheck = useCallback(() => {
    void invalidateBillingSnapshot(queryClient, 'recheck')
  }, [queryClient])

  return { ...snapshot, recheck }
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'

import { useBillingInfo } from '@renderer/hooks/use-billing-info'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { captureRendererException } from '@renderer/lib/error-reporting'

import { resolvePaywallCta, subscriptionRequiredFromBilling, type PaywallCta } from './platform-paywall-cta'

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

// Refresh the snapshot while the card is up, without touching anything outside this hook:
// - on return to the window (focus, or the tab becoming visible), coalesced, since that is
//   when the user comes back from the dashboard;
// - a bounded poll, only while a fresh snapshot denies access. That verdict proves the
//   proxy emits `access`, so the answer can flip; without it polling can never clear the
//   card. The poll pauses while the document is hidden.
function useBillingRefresh(active: boolean, blocked: boolean): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onReturn = () => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        void invalidateBillingSnapshot(queryClient, 'refresh-on-return')
      }, 50)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') onReturn()
    }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      if (timer !== null) clearTimeout(timer)
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [active, queryClient])

  useEffect(() => {
    if (!active || !blocked) return
    let id: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (id !== null) return
      id = setInterval(() => {
        void invalidateBillingSnapshot(queryClient, 'recheck-poll')
      }, PAYWALL_RECHECK_INTERVAL_MS)
    }
    const stop = () => {
      if (id === null) return
      clearInterval(id)
      id = null
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') stop()
      else start()
    }
    if (document.visibilityState !== 'hidden') start()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [active, blocked, queryClient])
}

// `flagFrom402` is the proxy's subscription_required flag when the 402 body kept it;
// `billingHref` is the provider-resolved CTA link (presentation.href).
// A live 402 ignores a leftover `allowed` snapshot from a previous recovery.
// A persisted 402 (switch session after a top-up) trusts the current snapshot.
// `active` is false once the card is dismissed: no refresh signals after that.
export function usePlatformPaywallBilling(
  flagFrom402: boolean | undefined,
  billingHref: string | null,
  live: boolean,
  active = true,
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

  useBillingRefresh(active && !snapshot.cleared, snapshot.blocked)

  const recheck = useCallback(() => {
    void invalidateBillingSnapshot(queryClient, 'recheck')
  }, [queryClient])

  return { ...snapshot, recheck }
}

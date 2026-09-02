import { useEffect, useMemo } from 'react'

import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import {
  isPlatformOrgAdmin,
  paywallBillingDetailsFromSnapshot,
  resolveOrgBillingUrl,
  resolvePaywallCta,
  subscriptionRequiredFromBilling,
  type PaywallBillingDetails,
  type PaywallCta,
} from '@shared/lib/llm-provider/paywall-cta'
import { useBillingInfo } from '@renderer/hooks/use-billing-info'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { captureRendererException } from '@renderer/lib/error-reporting'

export function usePaywallCta(presentation: ProviderErrorPresentation): {
  cta: PaywallCta | null
  details: PaywallBillingDetails | null
  loading: boolean
} {
  const { data: platformAuth } = usePlatformAuthStatus()
  const role = platformAuth?.role
  const flagFrom402 = presentation.paywall?.subscriptionRequired
  // Every paywall fetches the snapshot: it fills in a missing 402 flag and
  // supplies the status, balances, card, and auto-reload details shown below.
  const needsBilling = Boolean(presentation.paywall)
  const billingQuery = useBillingInfo(Boolean(platformAuth?.connected) && needsBilling)

  const billingError = needsBilling ? billingQuery.error : null
  useEffect(() => {
    if (!billingError) return
    // Degrades to the add-card CTA; report so the silent fallback is visible.
    console.warn('[PaywallCta] billing snapshot fetch failed:', billingError)
    captureRendererException(billingError, {
      tags: { area: 'paywall', op: 'billing-info' },
    })
  }, [billingError])

  return useMemo(() => {
    if (!presentation.paywall) return { cta: null, details: null, loading: false }

    if (needsBilling && billingQuery.isLoading) {
      return { cta: null, details: null, loading: true }
    }

    const billing = billingQuery.data?.billing
    return {
      cta: resolvePaywallCta({
        subscriptionRequired: flagFrom402 ?? subscriptionRequiredFromBilling(billing),
        role,
        hasPaymentMethod: billing?.hasPaymentMethod,
        paymentStatus: billing?.subscription.paymentStatus,
        billingHref: resolveOrgBillingUrl(platformAuth),
      }),
      details: isPlatformOrgAdmin(role) ? paywallBillingDetailsFromSnapshot(billing) : null,
      loading: false,
    }
  }, [
    billingQuery.data?.billing,
    billingQuery.isLoading,
    flagFrom402,
    role,
    needsBilling,
    platformAuth,
    presentation.paywall,
  ])
}

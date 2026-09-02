import { useEffect, useMemo } from 'react'

import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import {
  isPlatformOrgAdmin,
  resolveOrgBillingUrl,
  resolvePaywallCta,
  subscriptionRequiredFromBilling,
  type PaywallCta,
} from '@shared/lib/llm-provider/paywall-cta'
import { useBillingInfo } from '@renderer/hooks/use-billing-info'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { captureRendererException } from '@renderer/lib/error-reporting'

export function usePaywallCta(presentation: ProviderErrorPresentation): {
  cta: PaywallCta | null
  loading: boolean
  billingAccessKnown: boolean
  billingAccessAllowed: boolean
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
    if (!presentation.paywall) {
      return {
        cta: null,
        loading: false,
        billingAccessKnown: false,
        billingAccessAllowed: false,
      }
    }

    if (needsBilling && billingQuery.isLoading) {
      const canResolveFrom402 = platformAuth !== undefined && (
        flagFrom402 === true
        || (flagFrom402 === false && (role == null || !isPlatformOrgAdmin(role)))
      )
      return {
        cta: canResolveFrom402
          ? resolvePaywallCta({
              subscriptionRequired: flagFrom402,
              role,
              hasPaymentMethod: undefined,
              billingHref: resolveOrgBillingUrl(platformAuth),
            })
          : null,
        loading: true,
        billingAccessKnown: false,
        billingAccessAllowed: false,
      }
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
      loading: billingQuery.isFetching,
      billingAccessKnown:
        billingQuery.data?.stale !== true && billing?.access !== undefined,
      billingAccessAllowed:
        billingQuery.data?.stale !== true && billing?.access?.allowed === true,
    }
  }, [
    billingQuery.data?.billing,
    billingQuery.data?.stale,
    billingQuery.isFetching,
    billingQuery.isLoading,
    flagFrom402,
    role,
    needsBilling,
    platformAuth,
    presentation.paywall,
  ])
}

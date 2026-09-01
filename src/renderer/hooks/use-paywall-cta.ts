import { useEffect, useMemo } from 'react'

import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import {
  isPlatformOrgAdmin,
  resolveOrgBillingUrl,
  resolvePaywallCta,
  type PaywallCta,
} from '@shared/lib/llm-provider/paywall-cta'
import { useBillingInfo } from '@renderer/hooks/use-billing-info'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { captureRendererException } from '@renderer/lib/error-reporting'

export function usePaywallCta(presentation: ProviderErrorPresentation): {
  cta: PaywallCta | null
  loading: boolean
} {
  const { data: platformAuth } = usePlatformAuthStatus()
  const role = platformAuth?.role
  const needsBilling = Boolean(
    presentation.paywall
    && presentation.paywall.subscriptionRequired === false
    && isPlatformOrgAdmin(role),
  )
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
    if (!presentation.paywall) return { cta: null, loading: false }

    if (needsBilling && billingQuery.isLoading) {
      return { cta: null, loading: true }
    }

    return {
      cta: resolvePaywallCta({
        subscriptionRequired: presentation.paywall.subscriptionRequired,
        role,
        hasPaymentMethod: billingQuery.data?.billing?.hasPaymentMethod,
        billingHref: resolveOrgBillingUrl(platformAuth),
      }),
      loading: false,
    }
  }, [billingQuery.data?.billing?.hasPaymentMethod, billingQuery.isLoading, role, needsBilling, platformAuth, presentation.paywall])
}

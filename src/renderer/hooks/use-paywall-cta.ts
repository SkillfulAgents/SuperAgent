import { useMemo } from 'react'

import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import { resolvePresentationMarkdown } from '@shared/lib/llm-provider/error-presentation'
import { isPlatformOrgAdmin, resolvePaywallCta, type PaywallCta } from '@shared/lib/llm-provider/paywall-cta'
import { useBillingInfo } from '@renderer/hooks/use-billing-info'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'

const BILLING_HREF_MARKDOWN = '[billing](/dashboard/organizations/{orgId}?tab=billing)'

function billingHrefFromAuth(
  org: { connected?: boolean; platformBaseUrl?: string | null; orgId?: string | null } | null | undefined,
): string | null {
  const resolved = resolvePresentationMarkdown(BILLING_HREF_MARKDOWN, org)
  const match = resolved.match(/\((https?:\/\/[^)]+)\)/)
  return match?.[1] ?? null
}

export function usePaywallCta(presentation: ProviderErrorPresentation): {
  cta: PaywallCta | null
  loading: boolean
} {
  const { data: platformAuth } = usePlatformAuthStatus()
  const isOrgAdmin = isPlatformOrgAdmin(platformAuth?.role)
  const needsBilling = Boolean(
    presentation.paywall
    && presentation.paywall.subscriptionRequired === false
    && isOrgAdmin,
  )
  const billingQuery = useBillingInfo(Boolean(platformAuth?.connected) && needsBilling)

  return useMemo(() => {
    if (!presentation.paywall) return { cta: null, loading: false }

    const billingHref = billingHrefFromAuth(platformAuth)
    if (needsBilling && billingQuery.isLoading) {
      return { cta: null, loading: true }
    }

    return {
      cta: resolvePaywallCta({
        subscriptionRequired: presentation.paywall.subscriptionRequired,
        isOrgAdmin,
        hasPaymentMethod: billingQuery.data?.billing?.hasPaymentMethod,
        billingHref,
      }),
      loading: false,
    }
  }, [billingQuery.data?.billing?.hasPaymentMethod, billingQuery.isLoading, isOrgAdmin, needsBilling, platformAuth, presentation.paywall])
}

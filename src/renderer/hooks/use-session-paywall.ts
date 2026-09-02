import { useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'
import { usePaywallCta } from '@renderer/hooks/use-paywall-cta'

const NO_PAYWALL: ProviderErrorPresentation = {
  severity: 'error',
  icon: 'info',
  message: '',
}

export interface PaywallSource {
  messageId?: string
  message: string
  presentation: ProviderErrorPresentation
}

export function latestPersistedPaywall(
  messages: ApiMessageOrBoundary[] | undefined,
): PaywallSource | null {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages?.[i]
    if (message?.type !== 'assistant') continue
    if (!message.errorPresentation?.paywall) return null
    return {
      messageId: message.id,
      message: message.content.text,
      presentation: message.errorPresentation,
    }
  }
  return null
}

export function useSessionPaywall(
  live: PaywallSource | null,
  persisted: PaywallSource | null,
) {
  const source = live ?? persisted
  const queryClient = useQueryClient()

  // A live 402 outranks any snapshot fetched before it: within staleTime a
  // cached `allowed: true` from a previous recovery would instantly dismiss
  // the new paywall. Stamp its arrival and refetch.
  const liveSeenAt = useMemo(() => (live ? Date.now() : 0), [live])
  useEffect(() => {
    if (!live) return
    void queryClient.invalidateQueries({
      queryKey: ['platform-billing'],
      refetchType: 'active',
    })
  }, [live, queryClient])

  const billing = usePaywallCta(source?.presentation ?? NO_PAYWALL)
  const awaitingFreshVerdict =
    live !== null
    && billing.billingAccessKnown
    && billing.billingUpdatedAt <= liveSeenAt
  const active = source !== null && (
    billing.loading
    || awaitingFreshVerdict
    || (billing.billingAccessKnown && !billing.billingAccessAllowed)
  )

  return {
    active,
    suppressHistory: source !== null && (active || billing.billingAccessAllowed),
    source,
    ...billing,
  }
}

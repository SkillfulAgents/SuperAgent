import { useCallback } from 'react'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'

export interface PaywallAnalyticsContext {
  paywallId: string
  entryPoint: 'platform_paywall'
  paywallType: string
  ctaKind: string
  placement: string
}

export interface SubscriptionRecovery {
  attemptId: string
  provider: string
}

export function usePaywallTracking() {
  const { track } = useAnalyticsTracking()
  return useCallback((event: string, properties: Record<string, unknown>) => {
    // An analytics SDK failure must not stop sign-in, saving, or chat recovery.
    try { track(event, properties) }
    catch { console.warn('[Paywall] Could not track analytics event:', event) }
  }, [track])
}

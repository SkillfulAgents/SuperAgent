import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { clearPaywallErrors } from '@renderer/hooks/use-message-stream'

// Resume-after-top-up: the dashboard deep-links superagent://billing-updated
// once the purchase lands. Refetch the billing snapshot and clear paywall 402s
// so blocked sessions get their composer back. The deep link is signal-only;
// the refreshed balance comes from our own authenticated /v1/billing fetch.
export function useBillingUpdatedListener(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!window.electronAPI?.onBillingUpdated) return
    return window.electronAPI.onBillingUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: ['platform-billing'] })
      clearPaywallErrors()
    })
  }, [queryClient])
}

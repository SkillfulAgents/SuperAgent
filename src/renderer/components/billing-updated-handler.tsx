import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { BILLING_QUERY_KEY } from '@renderer/hooks/use-billing-info'

// `<scheme>://billing-updated` (dashboard hand-back after a top-up) → refetch the billing
// snapshot everywhere it is shown. Mounted once in RootLayout, like the other IPC handlers.
export function BillingUpdatedHandler() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onBillingUpdated?.(() => {
      void queryClient.invalidateQueries({ queryKey: BILLING_QUERY_KEY })
    })
    return () => unsubscribe?.()
  }, [queryClient])
  return null
}

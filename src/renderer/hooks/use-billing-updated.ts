import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { captureRendererException } from '@renderer/lib/error-reporting'

export function useBillingUpdatedListener(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    const reportRefreshError = (error: unknown) => {
      console.warn('[BillingUpdated] billing refresh failed:', error)
      captureRendererException(error, {
        tags: { area: 'paywall', op: 'refresh-after-update' },
      })
    }

    const run = () => {
      void queryClient.invalidateQueries({
        queryKey: ['platform-billing'],
        refetchType: 'active',
      }).catch(reportRefreshError)
    }

    let scheduledRun: ReturnType<typeof setTimeout> | null = null
    const scheduleRun = () => {
      if (scheduledRun !== null) return
      scheduledRun = setTimeout(() => {
        scheduledRun = null
        run()
      }, 50)
    }

    const removeElectronListener = window.electronAPI?.onBillingUpdated?.(scheduleRun)
    void window.electronAPI?.flushPendingBillingUpdated?.().then((had) => {
      if (had) scheduleRun()
    })

    const onFocus = () => scheduleRun()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleRun()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      if (scheduledRun !== null) clearTimeout(scheduledRun)
      removeElectronListener?.()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [queryClient])
}

import { useEffect } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'
import { recoverAfterBillingEvent } from '@renderer/lib/billing-recovery'
import {
  clearBillingResumeTarget,
  getBillingResumeTarget,
  type BillingResumeTarget,
} from '@renderer/lib/billing-resume-target'
import { captureRendererException } from '@renderer/lib/error-reporting'
import { clearPaywallError } from '@renderer/hooks/use-message-stream'
import type { BillingInfoResponse } from '@renderer/hooks/use-billing-info'

async function refreshBilling(queryClient: QueryClient): Promise<BillingInfoResponse> {
  const res = await apiFetch('/api/platform-auth/billing')
  if (!res.ok) throw new Error(`Billing refresh failed (${res.status})`)
  const snapshot = await res.json() as BillingInfoResponse
  queryClient.setQueryData(['platform-billing'], snapshot)
  return snapshot
}

async function requestResume(target: BillingResumeTarget): Promise<boolean> {
  const res = await apiFetch(
    `/api/agents/${encodeURIComponent(target.agentSlug)}/sessions/${encodeURIComponent(target.sessionId)}/resume-after-billing`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptId: target.attemptId }),
    },
  )
  if (res.ok) {
    clearBillingResumeTarget(target)
    clearPaywallError(target.sessionId)
    return true
  }
  if (res.status === 409) {
    const body = await res.json().catch(() => ({})) as { duplicate?: boolean }
    if (body.duplicate) {
      clearBillingResumeTarget(target)
      clearPaywallError(target.sessionId)
      return true
    }
  }
  throw new Error(`Resume request failed (${res.status})`)
}

export function useBillingUpdatedListener(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    const run = () => {
      void recoverAfterBillingEvent({
        refresh: () => refreshBilling(queryClient),
        resume: requestResume,
      }).catch((error) => {
        const target = getBillingResumeTarget()
        console.warn('[BillingUpdated] automatic continuation failed:', error)
        captureRendererException(error, {
          tags: { area: 'paywall', op: 'resume-after-update' },
          extra: target
            ? { agentSlug: target.agentSlug, sessionId: target.sessionId, attemptId: target.attemptId }
            : undefined,
        })
      })
    }

    const removeElectronListener = window.electronAPI?.onBillingUpdated?.(run)
    void window.electronAPI?.flushPendingBillingUpdated?.().then((had) => {
      if (had) run()
    })

    const onFocus = () => run()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') run()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      removeElectronListener?.()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [queryClient])
}

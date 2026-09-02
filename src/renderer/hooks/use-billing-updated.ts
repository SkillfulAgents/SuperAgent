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
    const reportRefreshError = (error: unknown) => {
      const target = getBillingResumeTarget()
      console.warn('[BillingUpdated] billing refresh or continuation failed:', error)
      captureRendererException(error, {
        tags: { area: 'paywall', op: 'resume-after-update' },
        extra: target
          ? { agentSlug: target.agentSlug, sessionId: target.sessionId, attemptId: target.attemptId }
          : undefined,
      })
    }

    const run = () => {
      if (!getBillingResumeTarget()) {
        void queryClient.invalidateQueries({
          queryKey: ['platform-billing'],
          refetchType: 'active',
        }).catch(reportRefreshError)
        return
      }
      void recoverAfterBillingEvent({
        refresh: () => refreshBilling(queryClient),
        resume: requestResume,
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

import { useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { useModelAvailabilityAction, type ModelAvailabilityActionRequest } from '@renderer/context/model-availability-action-context'
import { useBillingInfo } from '@renderer/hooks/use-billing-info'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { orgBillingUrl } from '@shared/lib/llm-provider/platform-error-presentation'
import { PLATFORM_PLAN_UPGRADE_ACTION } from '@shared/lib/llm-provider/platform-plan-policy'
import type { ParsedPlatformBillingInfo, ParsedPlatformPlan } from '@shared/lib/types/skillset-schema'

export interface PlatformPlan {
  /** The workspace's plan; null when not subscribed, unknown, or not on the platform. */
  plan: ParsedPlatformPlan | null
  pendingPlanChange: ParsedPlatformBillingInfo['pendingPlanChange']
  /** "Claude Fable and GPT Astra", worded by the server; null when the plan excludes nothing. */
  excludedLabel: string | null
  /** When the billing snapshot was last fetched (0 before the first). */
  updatedAt: number
  /** Refetch the billing snapshot (plan changes made in the billing page). */
  refresh: () => Promise<void>
}

/**
 * The connected workspace's plan, from the same billing snapshot the Account
 * screen shows (`['platform-billing']`), so a refresh anywhere unlocks models
 * everywhere. `enabled` gates the billing fetch for hosts that only need it
 * for a platform connection.
 */
export function usePlatformPlan(enabled = true): PlatformPlan {
  const queryClient = useQueryClient()
  const { data: platformAuth } = usePlatformAuthStatus()
  const active = enabled && platformAuth?.connected === true
  const billingQuery = useBillingInfo(active)
  const data = active ? billingQuery.data : undefined
  const plan = data?.billing?.plan ?? null
  const pendingPlanChange = data?.billing?.pendingPlanChange ?? null
  const excludedLabel = data?.excludedModels ?? null
  // `refetch` runs even for a disabled query, so only a connected workspace asks.
  const { refetch } = billingQuery
  const refresh = useCallback(async () => {
    if (active) {
      await refetch()
      await queryClient.invalidateQueries({ queryKey: ['provider-model-availability'] })
    }
  }, [active, refetch, queryClient])
  return useMemo(
    () => ({ plan, pendingPlanChange, excludedLabel, updatedAt: billingQuery.dataUpdatedAt, refresh }),
    [plan, pendingPlanChange, excludedLabel, billingQuery.dataUpdatedAt, refresh],
  )
}

/**
 * Opens the plan upgrade flow from the platform's own surfaces (Account's
 * "Change plan", the 403 card), which have no availability action to hand.
 */
export function usePlatformPlanUpgrade(): (request?: Omit<ModelAvailabilityActionRequest, 'action'> & { label?: string }) => void {
  const openAction = useModelAvailabilityAction()
  const { data: platformAuth } = usePlatformAuthStatus()
  const href = orgBillingUrl(platformAuth?.platformBaseUrl, platformAuth?.orgId)
  return useCallback(
    ({ label = 'Upgrade', ...request } = {}) =>
      openAction({ ...request, action: { component: PLATFORM_PLAN_UPGRADE_ACTION, label, href } }),
    [openAction, href],
  )
}

/** "Switching to Pro 30 on Nov 13" for a scheduled plan change. */
export function pendingPlanChangeText(pending: NonNullable<PlatformPlan['pendingPlanChange']>): string {
  const at = Date.parse(pending.effectiveAt)
  const when = Number.isFinite(at)
    ? `on ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : 'at renewal'
  return `Switching to ${pending.toPlan.name} ${when}`
}

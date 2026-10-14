import { useCallback, useMemo } from 'react'

import { familyDisplayName } from '@renderer/components/messages/model-family-list'
import { useBillingInfo } from '@renderer/hooks/use-billing-info'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { PLATFORM_CATALOG } from '@shared/lib/llm-provider/builtin-catalogs'
import { excludedModelsLabel, isDeniedByPlan } from '@shared/lib/llm-provider/plan-model-policy'
import type { ParsedPlatformBillingInfo, ParsedPlatformPlan } from '@shared/lib/types/skillset-schema'

export interface PlatformPlan {
  /** The workspace's plan; null when not subscribed, unknown, or not on the platform. */
  plan: ParsedPlatformPlan | null
  pendingPlanChange: ParsedPlatformBillingInfo['pendingPlanChange']
  /** Canonical model-id prefixes the plan excludes; empty = no restriction. */
  deniedModels: string[]
  /** "Claude Fable and GPT Astra", or null when the plan excludes nothing. */
  excludedLabel: string | null
  isDenied: (model: string) => boolean
  /** When the billing snapshot was last fetched (0 before the first). */
  updatedAt: number
  /** Refetch the billing snapshot (plan changes made in the billing page). */
  refresh: () => Promise<void>
}

const NO_DENIED: string[] = []

/**
 * The connected workspace's plan, from the same billing snapshot the Account
 * screen shows (`['platform-billing']`), so a refresh anywhere unlocks models
 * everywhere. `enabled` gates the billing fetch for hosts that only need it
 * for a platform connection.
 */
export function usePlatformPlan(enabled = true): PlatformPlan {
  const { data: platformAuth } = usePlatformAuthStatus()
  const active = enabled && platformAuth?.connected === true
  const billingQuery = useBillingInfo(active)
  const billing = active ? billingQuery.data?.billing : undefined
  const plan = billing?.plan ?? null
  const deniedModels = billing?.deniedModels ?? plan?.deniedModels ?? NO_DENIED
  const pendingPlanChange = billing?.pendingPlanChange ?? null
  // `refetch` runs even for a disabled query, so only a connected workspace asks.
  const { refetch } = billingQuery
  const refresh = useCallback(async () => {
    if (active) await refetch()
  }, [active, refetch])
  return useMemo(
    () => ({
      plan,
      pendingPlanChange,
      deniedModels,
      excludedLabel: excludedModelsLabel(deniedModels, PLATFORM_CATALOG, familyDisplayName),
      isDenied: (model: string) => isDeniedByPlan(deniedModels, model),
      updatedAt: billingQuery.dataUpdatedAt,
      refresh,
    }),
    [plan, pendingPlanChange, deniedModels, billingQuery.dataUpdatedAt, refresh],
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

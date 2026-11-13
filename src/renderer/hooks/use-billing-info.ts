import { useQuery, useQueryClient } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'
import { usePlatformAuthStatus, type PlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import type { ParsedPlatformBillingInfo } from '@shared/lib/types/skillset-schema'

export interface BillingInfoResponse {
  connected: boolean
  billing?: ParsedPlatformBillingInfo
  /** What the workspace's plan excludes ("Claude Fable and GPT Astra"), worded by the server; null = nothing. */
  excludedModels?: string | null
  /** True when the snapshot is a cached fallback after a live-fetch failure. */
  stale?: boolean
  /** ISO timestamp the cached snapshot was last fetched (present when stale). */
  lastRefreshedAt?: string | null
  error?: string
}

export function platformBillingQueryKey(auth: PlatformAuthStatus | null | undefined) {
  return ['platform-billing', auth?.platformBaseUrl ?? null, auth?.orgId ?? null, auth?.userId ?? null, auth?.memberId ?? null, auth?.updatedAt ?? null] as const
}

/**
 * Billing snapshot for the Account screen. Fetches on mount (which, since the
 * settings tab is lazily mounted, == refresh-on-view) and exposes `refetch`
 * for the manual Refresh button. `enabled` should track platform connectivity.
 *
 * The server keeps each snapshot's plan policy for model selection, replacing
 * the one it had cached, so every read here also has the pickers read their
 * availability again: opening Account shows a plan change everywhere at once.
 */
export function useBillingInfo(enabled: boolean) {
  const queryClient = useQueryClient()
  const { data: auth } = usePlatformAuthStatus()
  return useQuery<BillingInfoResponse>({
    // A billing response contains both org plan policy and member-specific credit.
    // Keep it separate across workspace/account switches, including two platform
    // hosts that happen to use the same org id. A reconnection also changes
    // updatedAt, so it cannot reuse a snapshot from the previous credential.
    queryKey: platformBillingQueryKey(auth),
    enabled,
    queryFn: async () => {
      const res = await apiFetch('/api/platform-auth/billing')
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to load billing')
      }
      const snapshot: BillingInfoResponse = await res.json()
      void queryClient.invalidateQueries({ queryKey: ['provider-model-availability'] })
      return snapshot
    },
    staleTime: 30_000,
  })
}

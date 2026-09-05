import { useQuery } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'
import type { ParsedPlatformBillingInfo } from '@shared/lib/types/skillset-schema'

export interface BillingInfoResponse {
  connected: boolean
  billing?: ParsedPlatformBillingInfo
  /** True when the snapshot is a cached fallback after a live-fetch failure. */
  stale?: boolean
  /** ISO timestamp the cached snapshot was last fetched (present when stale). */
  lastRefreshedAt?: string | null
  error?: string
}

/**
 * Billing snapshot for the Account screen. Fetches on mount (which, since the
 * settings tab is lazily mounted, == refresh-on-view) and exposes `refetch`
 * for the manual Refresh button. `enabled` should track platform connectivity.
 */
export function useBillingInfo(enabled: boolean) {
  return useQuery<BillingInfoResponse>({
    queryKey: ['platform-billing'],
    enabled,
    queryFn: async () => {
      const res = await apiFetch('/api/platform-auth/billing')
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to load billing')
      }
      return res.json()
    },
    staleTime: 30_000,
  })
}

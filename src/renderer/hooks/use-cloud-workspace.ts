import { useQuery } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'

export interface CloudWorkspaceResponse {
  /** Running under Electron with a connected, member-bound platform account. */
  available: boolean
  /** A deployed cloud workspace exists for the account. */
  found: boolean
  deploymentUrl: string | null
  orgId: string | null
  /** Whether a live deployment token is held (infra/diagnostic). */
  hasValidToken: boolean
  /**
   * Discovery failed, so `found: false` means "couldn't check" — not "there
   * isn't one". Show a retry, never the create-a-workspace CTA.
   */
  discoveryFailed: boolean
}

/**
 * Cloud-workspace status for the Account screen. Fetches on mount (== refresh
 * on view, since the settings tab is lazily mounted); the GET also runs the
 * backend discover → ensure-deployment-token cycle. `enabled` should track
 * platform connectivity (and Electron — the card is desktop-only).
 */
export function useCloudWorkspace(enabled: boolean) {
  return useQuery<CloudWorkspaceResponse>({
    queryKey: ['cloud-workspace'],
    enabled,
    queryFn: async () => {
      const res = await apiFetch('/api/platform-auth/deployments')
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to load cloud workspace')
      }
      return res.json()
    },
    staleTime: 5 * 60_000,
  })
}

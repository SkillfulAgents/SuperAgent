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
  /** Deployed SuperAgent version from platform discovery, or null if unknown. */
  superagentVersion: string | null
}

/**
 * Cloud-workspace status. Prefers IPC in Electron (works in cloud mode); HTTP
 * fallback for tests. `orgId` is a cache key so org A's URL can't flash under B.
 */
export function useCloudWorkspace(enabled: boolean, orgId?: string | null) {
  return useQuery<CloudWorkspaceResponse>({
    queryKey: ['cloud-workspace', orgId ?? null],
    enabled,
    queryFn: async () => {
      if (window.electronAPI?.getCloudWorkspace) {
        return window.electronAPI.getCloudWorkspace()
      }
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

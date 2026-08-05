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
 * Cloud-workspace status. Prefers IPC in Electron — in cloud mode HTTP would
 * proxy to the deployment, which self-gates and answers "not available" about
 * itself. The HTTP path serves non-Electron renderers (web) and tests.
 *
 * `orgId` is part of the cache key, not just a parameter: the response carries
 * a deployment URL the user can click "Open" on, and a single global key would
 * let one account's workspace render under another's while the refetch is
 * still in flight. Connect/reconnect additionally *resets* this key — see
 * `use-platform-auth`.
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

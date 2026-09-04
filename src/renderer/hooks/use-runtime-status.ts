import { useTargetSwitch } from '@renderer/hooks/use-target-switch'
import { apiFetch, cloudApiFetch } from '@renderer/lib/api'
import { getApiBaseUrl, getCloudApiBaseUrl } from '@renderer/lib/env'
import { useQuery } from '@tanstack/react-query'
import type { RuntimeReadiness } from '@shared/lib/container/types'

export interface RuntimeStatusResponse {
  runtimeReadiness: RuntimeReadiness
  hasRunningAgents: boolean
  apiKeyConfigured: boolean
  /** Non-null when background services failed to init and the server runs degraded. */
  servicesInitError: string | null
  /** Optional because a deployment built before this field omits it. */
  appVersion?: string
}

async function readRuntimeStatus(res: Response): Promise<RuntimeStatusResponse> {
  if (!res.ok) throw new Error('Failed to fetch runtime status')
  return res.json()
}

export function useRuntimeStatus() {
  return useQuery<RuntimeStatusResponse>({
    queryKey: ['runtime-status', getApiBaseUrl()],
    queryFn: async () => readRuntimeStatus(await apiFetch('/api/runtime-status')),
    refetchInterval: 30000,
  })
}

/**
 * The deployment's runtime status on either tab. Single source for the cloud
 * number. Enabled while the cloud proxy door exists and a workspace is
 * reachable (the same live check that shows the Local/Cloud switcher).
 *
 * Keyed by origin rather than by a literal, so that on the cloud tab — where
 * this window already drives the deployment and both origins are the same
 * string — this collapses onto `useRuntimeStatus`'s query instead of polling
 * the same server twice every 30 seconds. The origin is a cache key here and
 * never a URL: both requests are composed by the wrappers above, which is why
 * this module's entry in the origin characterization inventory says so.
 */
export function useCloudRuntimeStatus() {
  const door = getCloudApiBaseUrl()
  const { available } = useTargetSwitch()
  return useQuery<RuntimeStatusResponse>({
    queryKey: ['runtime-status', door],
    queryFn: async () => readRuntimeStatus(await cloudApiFetch('/api/runtime-status')),
    enabled: door !== null && available,
    refetchInterval: 30000,
  })
}

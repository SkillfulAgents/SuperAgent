import { useTargetSwitch } from '@renderer/hooks/use-target-switch'
import { handleUnauthorizedResponse } from '@renderer/lib/api'
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

async function fetchRuntimeStatus(baseUrl: string): Promise<RuntimeStatusResponse> {
  const res = await fetch(`${baseUrl}/api/runtime-status`)
  await handleUnauthorizedResponse(res.status, '/api/runtime-status')
  if (!res.ok) throw new Error('Failed to fetch runtime status')
  return res.json()
}

export function useRuntimeStatus() {
  const baseUrl = getApiBaseUrl()
  return useQuery<RuntimeStatusResponse>({
    queryKey: ['runtime-status', baseUrl],
    queryFn: () => fetchRuntimeStatus(baseUrl),
    refetchInterval: 30000,
  })
}

/**
 * The deployment's runtime status on either tab. Single source for the
 * cloud number. Enabled while the cloud proxy door exists and a workspace
 * is reachable (the same live check that shows the Local/Cloud switcher).
 */
export function useCloudRuntimeStatus() {
  const door = getCloudApiBaseUrl()
  const { available } = useTargetSwitch()
  return useQuery<RuntimeStatusResponse>({
    queryKey: ['runtime-status', door],
    queryFn: () => {
      if (door === null) throw new Error('Cloud proxy door is not available')
      return fetchRuntimeStatus(door)
    },
    enabled: door !== null && available,
    refetchInterval: 30000,
  })
}

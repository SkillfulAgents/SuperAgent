import { apiFetch } from '@renderer/lib/api'
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

const RUNTIME_STATUS_POLL_MS = 30_000

export function useRuntimeStatus() {
  return useQuery<RuntimeStatusResponse>({
    queryKey: ['runtime-status'],
    queryFn: async () => {
      const res = await apiFetch('/api/runtime-status')
      if (!res.ok) throw new Error('Failed to fetch runtime status')
      return res.json()
    },
    refetchInterval: RUNTIME_STATUS_POLL_MS,
    // Readiness arrives on the notifications stream and a settings write
    // invalidates this, so a new observer reuses what is cached instead of
    // refetching on every navigation (the 5 s default). The window is the
    // poll's interval and no longer: nothing announces a key another admin
    // configured, so a mount after it reads again, as the poll would have.
    staleTime: RUNTIME_STATUS_POLL_MS,
    // Back online is read again as before, without waiting out the window.
    refetchOnReconnect: 'always',
  })
}

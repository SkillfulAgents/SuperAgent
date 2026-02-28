import { apiFetch } from '@renderer/lib/api'
import { useQuery } from '@tanstack/react-query'
import type { RuntimeReadiness } from '@shared/lib/container/types'

export interface RuntimeStatusResponse {
  runtimeReadiness: RuntimeReadiness
  hasRunningAgents: boolean
  apiKeyConfigured: boolean
}

export function useRuntimeStatus() {
  return useQuery<RuntimeStatusResponse>({
    queryKey: ['runtime-status'],
    queryFn: async () => {
      const res = await apiFetch('/api/runtime-status')
      if (!res.ok) throw new Error('Failed to fetch runtime status')
      return res.json()
    },
    refetchInterval: 60000,
  })
}

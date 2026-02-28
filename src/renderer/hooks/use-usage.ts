import { apiFetch } from '@renderer/lib/api'
import { useQuery } from '@tanstack/react-query'
import type { UsageResponse } from '@shared/lib/types/usage'

export function useUsageData(days: number, global?: boolean) {
  return useQuery<UsageResponse>({
    queryKey: ['usage', days, global],
    queryFn: async () => {
      const params = new URLSearchParams({ days: String(days) })
      if (global) params.set('global', 'true')
      const res = await apiFetch(`/api/usage?${params}`)
      if (!res.ok) throw new Error('Failed to fetch usage data')
      return res.json()
    },
    enabled: false,
  })
}

import { apiFetch } from '@renderer/lib/api'
import { useQuery } from '@tanstack/react-query'
import type { UsageResponse } from '@shared/lib/types/usage'

export function useUsageData(days: number) {
  return useQuery<UsageResponse>({
    queryKey: ['usage', days],
    queryFn: async () => {
      const res = await apiFetch(`/api/usage?days=${days}`)
      if (!res.ok) throw new Error('Failed to fetch usage data')
      return res.json()
    },
    enabled: false,
  })
}

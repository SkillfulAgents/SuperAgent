import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import type {
  AgentActivityStats,
  ConnectionActivityStats,
} from '@shared/lib/types/activity'
import { DEFAULT_ACTIVITY_DAYS } from '@shared/lib/types/activity'

const ACTIVITY_STALE_TIME_MS = 60_000
const ACTIVITY_REFETCH_INTERVAL_MS = 120_000

async function activityJson<T>(url: string): Promise<T> {
  const response = await apiFetch(url)
  if (!response.ok) throw new Error('Failed to fetch activity statistics')
  return response.json() as Promise<T>
}

export function useAgentActivityStats(
  agentSlug: string | null,
  days = DEFAULT_ACTIVITY_DAYS,
) {
  return useQuery<AgentActivityStats>({
    queryKey: ['activity-stats', 'agent', agentSlug, days],
    queryFn: () => activityJson(
      `/api/activity/agents/${encodeURIComponent(agentSlug!)}?days=${days}`,
    ),
    enabled: !!agentSlug,
    staleTime: ACTIVITY_STALE_TIME_MS,
    refetchInterval: ACTIVITY_REFETCH_INTERVAL_MS,
  })
}

export function useConnectionActivityStats(days = DEFAULT_ACTIVITY_DAYS) {
  return useQuery<ConnectionActivityStats>({
    queryKey: ['activity-stats', 'connections', days],
    queryFn: () => activityJson(`/api/activity/connections?days=${days}`),
    staleTime: ACTIVITY_STALE_TIME_MS,
    refetchInterval: ACTIVITY_REFETCH_INTERVAL_MS,
  })
}

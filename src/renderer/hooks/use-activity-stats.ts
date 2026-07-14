import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@renderer/lib/api'
import { DEFAULT_ACTIVITY_DAYS } from '@shared/lib/types/activity'
import {
  agentActivityStatsSchema,
  connectionActivityStatsSchema,
} from '@shared/lib/types/activity-schema'

const ACTIVITY_STALE_TIME_MS = 60_000
const ACTIVITY_REFETCH_INTERVAL_MS = 120_000

async function activityJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await apiFetch(url)
  if (!response.ok) throw new Error('Failed to fetch activity statistics')
  return schema.parse(await response.json())
}

export function useAgentActivityStats(
  agentSlug: string | null,
  days = DEFAULT_ACTIVITY_DAYS,
) {
  // Day buckets follow the viewer's clock; the offset keys the cache so a
  // timezone change (travel, DST) doesn't serve stale-bucketed series.
  const tzOffsetMinutes = new Date().getTimezoneOffset()
  return useQuery({
    queryKey: ['activity-stats', 'agent', agentSlug, days, tzOffsetMinutes],
    queryFn: () => activityJson(
      `/api/activity/agents/${encodeURIComponent(agentSlug!)}?days=${days}&tz=${tzOffsetMinutes}`,
      agentActivityStatsSchema,
    ),
    enabled: !!agentSlug,
    staleTime: ACTIVITY_STALE_TIME_MS,
    refetchInterval: ACTIVITY_REFETCH_INTERVAL_MS,
    // A trigger/connection created moments ago (agent home is mounted right
    // after) must not wait out staleTime+poll to get its chart; the response
    // is a small SQL rollup, so a refetch per mount is cheap.
    refetchOnMount: 'always',
  })
}

export function useConnectionActivityStats(days = DEFAULT_ACTIVITY_DAYS) {
  const tzOffsetMinutes = new Date().getTimezoneOffset()
  return useQuery({
    queryKey: ['activity-stats', 'connections', days, tzOffsetMinutes],
    queryFn: () => activityJson(
      `/api/activity/connections?days=${days}&tz=${tzOffsetMinutes}`,
      connectionActivityStatsSchema,
    ),
    staleTime: ACTIVITY_STALE_TIME_MS,
    refetchInterval: ACTIVITY_REFETCH_INTERVAL_MS,
    refetchOnMount: 'always',
  })
}

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { DEFAULT_ACTIVITY_DAYS } from '@shared/lib/types/activity'
import {
  homeCardHealthSchema,
  type HomeCardHealthData,
} from '@shared/lib/types/home-card-health-schema'

export function useHomeCardHealth(
  enabled: boolean,
  days = DEFAULT_ACTIVITY_DAYS,
) {
  const tzOffsetMinutes = new Date().getTimezoneOffset()
  return useQuery<HomeCardHealthData>({
    queryKey: ['home-card-health', days, tzOffsetMinutes],
    queryFn: async () => {
      const response = await apiFetch(`/api/home-card-health?days=${days}&tz=${tzOffsetMinutes}`)
      if (!response.ok) throw new Error('Failed to fetch home card health')
      return homeCardHealthSchema.parse(await response.json())
    },
    enabled,
    staleTime: 60_000,
    // A single batch replaces the former per-card requests, so refresh once
    // whenever the cards page mounts instead of polling every carousel.
    refetchOnMount: 'always',
  })
}

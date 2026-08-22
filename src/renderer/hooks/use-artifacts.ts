import { apiFetch } from '@renderer/lib/api'
import { useQuery } from '@tanstack/react-query'

export interface ArtifactInfo {
  slug: string
  name: string
  description: string
  status: 'running' | 'stopped' | 'crashed' | 'starting'
  port: number
  startupPhase?: 'installing-dependencies' | 'starting-server'
  firstRun?: boolean
}

/**
 * Default cadence, or 300ms when the viewed dashboard is actively waiting —
 * a dashboard becomes serveable in well under a second once its port is up,
 * so a 1s poll was a large share of the perceived wait. The fast interval
 * only applies while a DashboardView is mounted and unresolved (pollFast).
 *
 * `watching` is the 1s floor for that same mounted-and-unresolved window:
 * pollFast deliberately turns off after the slow bound, and a queued
 * dashboard still reports 'stopped' — without the floor, exactly the
 * slowest starts fell back to the 60s idle cadence and sat invisible for
 * up to a minute after coming up.
 */
export function artifactsRefetchIntervalMs(
  data: ArtifactInfo[] | undefined,
  pollFast: boolean,
  watching: boolean = false,
): number {
  if (pollFast) return 300
  const hasStarting = data?.some((a) => a.status === 'starting')
  return watching || hasStarting ? 1_000 : 60_000
}

export function useArtifacts(
  agentSlug: string | null,
  options?: { pollFast?: boolean; watching?: boolean },
) {
  const pollFast = options?.pollFast ?? false
  const watching = options?.watching ?? false
  return useQuery<ArtifactInfo[]>({
    queryKey: ['artifacts', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/artifacts`)
      if (!res.ok) throw new Error('Failed to fetch artifacts')
      return res.json()
    },
    enabled: !!agentSlug,
    staleTime: 60_000,
    refetchInterval: (query) => artifactsRefetchIntervalMs(query.state.data, pollFast, watching),
  })
}

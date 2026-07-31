import { apiFetch } from '@renderer/lib/api'
import { useQuery } from '@tanstack/react-query'

export interface ArtifactInfo {
  slug: string
  name: string
  description: string
  status: 'running' | 'stopped' | 'crashed' | 'starting'
  port: number
}

/** Default cadence, or 1s when the viewed dashboard is actively waiting. */
export function artifactsRefetchIntervalMs(
  data: ArtifactInfo[] | undefined,
  pollFast: boolean,
): number {
  if (pollFast) return 1_000
  const hasStarting = data?.some((a) => a.status === 'starting')
  return hasStarting ? 1_000 : 60_000
}

export function useArtifacts(
  agentSlug: string | null,
  options?: { pollFast?: boolean },
) {
  const pollFast = options?.pollFast ?? false
  return useQuery<ArtifactInfo[]>({
    queryKey: ['artifacts', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/artifacts`)
      if (!res.ok) throw new Error('Failed to fetch artifacts')
      return res.json()
    },
    enabled: !!agentSlug,
    staleTime: 60_000,
    refetchInterval: (query) => artifactsRefetchIntervalMs(query.state.data, pollFast),
  })
}

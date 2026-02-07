import { apiFetch } from '@renderer/lib/api'
import { useQuery } from '@tanstack/react-query'

export interface ArtifactInfo {
  slug: string
  name: string
  description: string
  status: 'running' | 'stopped' | 'crashed' | 'starting'
  port: number
}

export function useArtifacts(agentSlug: string | null) {
  return useQuery<ArtifactInfo[]>({
    queryKey: ['artifacts', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/artifacts`)
      if (!res.ok) throw new Error('Failed to fetch artifacts')
      return res.json()
    },
    enabled: !!agentSlug,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
}

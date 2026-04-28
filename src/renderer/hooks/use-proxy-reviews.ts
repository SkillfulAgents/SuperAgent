import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'

export interface PendingReview {
  id: string
  agentSlug: string
  accountId: string
  toolkit: string
  method: string
  targetPath: string
  matchedScopes: string[]
  scopeDescriptions: Record<string, string>
  displayText?: string
  xAgent?: {
    targetAgentSlug: string
    targetAgentName: string
    operation: 'list' | 'read' | 'invoke' | 'create'
    preview?: string
  }
}

export function usePendingProxyReviews(agentSlug: string) {
  return useQuery<{ reviews: PendingReview[] }>({
    queryKey: ['proxy-reviews', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/proxy-reviews`)
      if (!res.ok) return { reviews: [] }
      return res.json()
    },
    refetchInterval: 30000,
  })
}

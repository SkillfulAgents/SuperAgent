import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useAgents, resolveRouteAgentId } from '@renderer/hooks/use-agents'

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
  // Key on the CANONICAL agent id, not the raw slug. The URL carries the display
  // slug (`{name}-{id}`) but GlobalNotificationHandler's SSE invalidations target
  // `['proxy-reviews', <server agentSlug = id>]`. Keyed on the display slug those
  // invalidations MISS, so a freshly-created review card only surfaces on the 30s
  // poll (status flips to "needs input" instantly via the agents invalidation,
  // but the card lags). Resolving collapses both forms onto one id-keyed entry.
  const { data: agents } = useAgents()
  const resolvedSlug = resolveRouteAgentId(agentSlug, agents) ?? agentSlug
  return useQuery<{ reviews: PendingReview[] }>({
    queryKey: ['proxy-reviews', resolvedSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${resolvedSlug}/proxy-reviews`)
      if (!res.ok) return { reviews: [] }
      return res.json()
    },
    refetchInterval: 30000,
  })
}

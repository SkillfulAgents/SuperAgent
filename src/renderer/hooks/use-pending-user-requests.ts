import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@renderer/lib/api'
import { useAgents, resolveRouteAgentId } from '@renderer/hooks/use-agents'
import {
  pendingUserInputRequestSchema,
  type PendingUserInputRequest,
} from '@shared/lib/user-input/request-schema'

const snapshotSchema = z.object({ requests: z.array(pendingUserInputRequestSchema) })

/**
 * The unified pending user-input request store: every open request visible in
 * a scope — all session-scoped kinds plus the agent-scoped reviews that block
 * every session of the agent — as one typed list from one snapshot endpoint.
 *
 * Events are invalidation triggers, not data carriers: user_request_created /
 * user_request_resolved on the session and global SSE streams invalidate this
 * query, and the refetch reads the server's registry — the same projection
 * that drives the awaiting-input status. The interval refetch is the safety
 * net for a missed event (matching the legacy proxy-review poll).
 */
export function usePendingUserRequests(agentSlug: string, sessionId?: string) {
  // Key on the CANONICAL agent id: the URL carries the display slug, but SSE
  // invalidations are broad (['pending-user-requests']) and the snapshot URL
  // must hit one stable cache entry per agent regardless of the slug form the
  // caller happened to hold (same reasoning as usePendingProxyReviews).
  const { data: agents } = useAgents()
  const resolvedSlug = resolveRouteAgentId(agentSlug, agents) ?? agentSlug
  return useQuery<PendingUserInputRequest[]>({
    queryKey: ['pending-user-requests', resolvedSlug, sessionId ?? null],
    queryFn: async () => {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      const res = await apiFetch(`/api/agents/${resolvedSlug}/pending-requests${query}`)
      if (!res.ok) {
        // A failed fetch must be an ERROR, not an empty success: returning []
        // would overwrite good cached data — every card vanishes and the
        // activity indicator reads "Working..." while the agent is blocked.
        // Throwing keeps the last snapshot and lets React Query retry.
        throw new Error(`Pending-requests snapshot failed: ${res.status}`)
      }
      return snapshotSchema.parse(await res.json()).requests
    },
    refetchInterval: 30000,
  })
}

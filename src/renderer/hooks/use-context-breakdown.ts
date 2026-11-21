import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { contextBreakdownResponseSchema, type ContextBreakdown } from '@shared/lib/container/context-breakdown-schema'

/**
 * What fills a session's context window, counted in full. Each read costs the
 * runtime token-count calls, so it is fetched only while something shows it
 * (`enabled`) and refreshed by the caller (a turn ending, a Refresh click),
 * never on an interval. null = no live runtime to ask.
 */
export function useContextBreakdown(sessionId: string, agentSlug: string, enabled: boolean) {
  return useQuery<ContextBreakdown | null>({
    queryKey: ['context-breakdown', agentSlug, sessionId],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/context`)
      if (!res.ok) throw new Error('Failed to read context')
      return contextBreakdownResponseSchema.parse(await res.json()).breakdown
    },
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
}

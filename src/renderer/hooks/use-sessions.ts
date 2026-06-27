import { apiFetch, apiJson } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useAgents, resolveRouteAgentId, type ApiAgent } from '@renderer/hooks/use-agents'
import type { ApiSession } from '@shared/lib/types/api'
import type { EffortLevel } from '@shared/lib/container/types'

// Re-export for convenience
export type { ApiSession }

// Session caches are keyed by the CANONICAL agent id so a given agent's sessions
// land on ONE cache entry — the URL carries the decorative display slug
// (`{name}-{id}`) while the sidebar, mutations and SSE invalidations all key on
// the bare id. Resolving every slug form through the loaded agents list before it
// reaches a query key is what stops the same session list/entry from splitting in
// two (one stale half that invalidations never reach). `useAgents` is shared
// (deduped) so this adds no real fetch cost.
function useResolvedAgentSlug(agentSlug: string | null): string | null {
  const { data: agents } = useAgents()
  if (!agentSlug) return null
  return resolveRouteAgentId(agentSlug, agents) ?? agentSlug
}

/** One-shot resolution for mutation invalidations, reading the cached agents list. */
function resolveAgentSlugFromCache(queryClient: QueryClient, agentSlug: string): string {
  const agents = queryClient.getQueryData<ApiAgent[]>(['agents'])
  return resolveRouteAgentId(agentSlug, agents) ?? agentSlug
}

export function useSessions(agentSlug: string | null, options?: { staleTime?: number }) {
  const resolvedSlug = useResolvedAgentSlug(agentSlug)
  return useQuery<ApiSession[]>({
    queryKey: ['sessions', resolvedSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${resolvedSlug}/sessions`)
      if (!res.ok) throw new Error('Failed to fetch sessions')
      return res.json()
    },
    enabled: !!resolvedSlug,
    staleTime: options?.staleTime,
  })
}

export function useSession(id: string | null, agentSlug: string | null = null) {
  const resolvedSlug = useResolvedAgentSlug(agentSlug)
  return useQuery<ApiSession>({
    queryKey: ['session', id, resolvedSlug],
    // `apiJson` throws `HttpError` carrying the status, so the session leaf can
    // distinguish a 404 (missing session) from a 5xx/network error.
    queryFn: () => apiJson<ApiSession>(`/api/agents/${resolvedSlug}/sessions/${id}`),
    enabled: !!id && !!resolvedSlug,
    // A 404 here means the session is genuinely missing: the backend's
    // getSession is metadata-authoritative, so a just-created session — which is
    // registered in metadata synchronously as part of the create response — is
    // readable immediately, before its JSONL transcript is even written. The
    // default retry is kept only as ordinary transient-error resilience.
  })
}

export function useCreateSession() {
  const queryClient = useQueryClient()
  const { track } = useAnalyticsTracking()

  return useMutation({
    mutationFn: async (data: { agentSlug: string; message: string; effort?: EffortLevel; model?: string }) => {
      const res = await apiFetch(`/api/agents/${data.agentSlug}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: data.message,
          ...(data.effort ? { effort: data.effort } : {}),
          ...(data.model ? { model: data.model } : {}),
        }),
      })
      if (!res.ok) throw new Error('Failed to create session')
      // initialMessageUuid is the server-assigned id of the initial message,
      // used to materialize the optimistic pending copy by exact id match.
      return res.json() as Promise<ApiSession & { initialMessageUuid: string }>
    },
    onSuccess: (_, variables) => {
      track('session_created')
      track('message_sent')
      queryClient.invalidateQueries({
        queryKey: ['sessions', resolveAgentSlugFromCache(queryClient, variables.agentSlug)],
      })
    },
  })
}

export function useDeleteSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, agentSlug }: { id: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete session')
      // 204 No Content - no body to parse
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['sessions', resolveAgentSlugFromCache(queryClient, variables.agentSlug)],
      })
    },
  })
}

export function useUpdateSessionName() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ sessionId, agentSlug, name }: { sessionId: string; agentSlug: string; name: string }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error('Failed to update session name')
      return res.json() as Promise<ApiSession>
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['sessions', resolveAgentSlugFromCache(queryClient, variables.agentSlug)],
      })
    },
  })
}

import { apiFetch, apiJson } from '@renderer/lib/api'
import { useCallback } from 'react'
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useDraftsStore, snapshotSessionDraft, seedSessionDraft } from '@renderer/context/drafts-context'
import { useAgents, resolveRouteAgentId, type ApiAgent } from '@renderer/hooks/use-agents'
import { applySessionActivityStatus, patchSessionInCaches } from '@renderer/lib/agent-cache'
import type { ApiSession } from '@shared/lib/types/api'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'
import type { SessionDashboardDispatch } from '@shared/lib/dashboard-dispatch-schema'

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

/**
 * Notable-only slice (live or carrying unread notifications) for badge and
 * toolbar consumers. The full list makes the server stat every transcript in
 * the agent's directory — 20k stats for a 20k-session agent — where this
 * path stats only the handful of notable ids. Keyed under the same
 * ['sessions', slug] prefix so SSE-driven invalidations reach it too.
 */
export function useNotableSessions(agentSlug: string | null, options?: { limit?: number; staleTime?: number }) {
  const resolvedSlug = useResolvedAgentSlug(agentSlug)
  const limit = options?.limit ?? 25
  return useQuery<ApiSession[]>({
    queryKey: ['sessions', resolvedSlug, 'notable', limit],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${resolvedSlug}/sessions?notable=true&limit=${limit}`)
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
    mutationFn: async (data: {
      agentSlug: string
      message: string
      effort?: EffortLevel
      speed?: SpeedLevel
      model?: string
      // Provenance for sessions confirmed via a dashboard's dispatch dialog.
      dashboardDispatch?: SessionDashboardDispatch
      // Analytics-only: distinguishes auto-started sessions (template onboarding)
      // from user-typed ones. Not sent to the server.
      origin?: 'user' | 'onboarding'
    }) => {
      const res = await apiFetch(`/api/agents/${data.agentSlug}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: data.message,
          ...(data.effort ? { effort: data.effort } : {}),
          ...(data.speed ? { speed: data.speed } : {}),
          ...(data.model ? { model: data.model } : {}),
          ...(data.dashboardDispatch ? { dashboardDispatch: data.dashboardDispatch } : {}),
        }),
      })
      if (!res.ok) throw new Error('Failed to create session')
      // initialMessageUuid is the server-assigned id of the initial message,
      // used to materialize the optimistic pending copy by exact id match.
      return res.json() as Promise<ApiSession & { initialMessageUuid: string }>
    },
    onSuccess: (created, variables) => {
      const origin = variables.origin ?? 'user'
      track('session_created', { origin })
      track('message_sent', { origin })
      const resolvedSlug = resolveAgentSlugFromCache(queryClient, variables.agentSlug)
      // Seed the caches from the response so the sidebar row and the session
      // view render immediately instead of waiting a refetch round-trip. The
      // new session is live, and the server sorts live sessions first, so
      // prepending approximates its refetched position. (The extra
      // initialMessageUuid field is a harmless superset of ApiSession.)
      queryClient.setQueryData<ApiSession>(['session', created.id, resolvedSlug], created)
      queryClient.setQueryData<ApiSession[]>(['sessions', resolvedSlug], (sessions) => (
        sessions && !sessions.some((s) => s.id === created.id)
          ? [created, ...sessions]
          : sessions
      ))
      // The seeds are create-TIME snapshots and setQueryData marks them fresh —
      // on a fast turn (E2E mock; a quick real reply) the session can change
      // (schedule a wake, go idle) BEFORE this onSuccess runs, and the
      // session_updated invalidation that announced it then predates the seed:
      // without re-marking stale here, the detail entry would pin that stale
      // snapshot (no poll refreshes it) and the pending-wake banner never
      // appears. Invalidate both so the seed renders instantly while the
      // refetch right behind it stays authoritative.
      queryClient.invalidateQueries({ queryKey: ['session', created.id] })
      queryClient.invalidateQueries({ queryKey: ['sessions', resolvedSlug] })
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
    onSuccess: (updated, variables) => {
      // Write the rename through the caches so the row doesn't flash back to
      // the old name while the list refetch is in flight. Name only — status
      // flags keep flowing through their own optimistic echoes.
      patchSessionInCaches(queryClient, variables.agentSlug, updated.id, (session) => (
        session.name === updated.name ? session : { ...session, name: updated.name }
      ))
      // The write-through bumped the patched entries' freshness — re-mark them
      // stale so concurrent server-side changes still refetch on mount.
      queryClient.invalidateQueries({ queryKey: ['session', updated.id] })
      queryClient.invalidateQueries({
        queryKey: ['sessions', resolveAgentSlugFromCache(queryClient, variables.agentSlug)],
      })
    },
  })
}

/**
 * Raise ("Mark as unread") or clear the user-driven unread dot on a session.
 * Clearing is fired when the session is opened; see SessionView.
 */
export function useSetSessionMarkedUnread() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({
      sessionId,
      agentSlug,
      markedUnread,
    }: { sessionId: string; agentSlug: string; markedUnread: boolean }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/unread`, {
        method: markedUnread ? 'POST' : 'DELETE',
      })
      if (!res.ok) throw new Error('Failed to update session unread flag')
      return res.json() as Promise<{ success: boolean; markedUnread: boolean; changed: boolean }>
    },
    onSuccess: (data, variables) => {
      // The clear fires on every session open, and almost always clears a flag
      // that was never set. Refetching on that no-op would re-stat every
      // session in the agent's directory (the sessions list) and re-enrich
      // every agent (the agents list) for nothing, so the server reports
      // whether it actually wrote and we invalidate only then.
      if (!data.changed) return
      queryClient.invalidateQueries({
        queryKey: ['sessions', resolveAgentSlugFromCache(queryClient, variables.agentSlug)],
      })
      // The agent row rolls session dots up into its own indicator.
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

/**
 * Drop a session's unread dot from every cache that renders it: the agent's
 * session lists, the single-session entries, and the agent-level rollup —
 * which only comes down once no OTHER cached session of that agent is still
 * unread. The server write follows on its own; clearing the caches up front
 * is what makes opening a session feel instant instead of holding the dot for
 * a roundtrip plus a session-list refetch.
 *
 * A thin delegate: applySessionActivityStatus owns the traversal, aliasing,
 * and rollup guards, so the raise (SSE notification) and clear (session open)
 * directions can never drift apart again.
 *
 * Returns whether a dot was actually showing, so a caller can tell a real
 * clear from the no-op that every other session open performs.
 */
export function clearSessionUnreadInCache(
  queryClient: QueryClient,
  agentSlug: string,
  sessionId: string,
): boolean {
  return applySessionActivityStatus(queryClient, agentSlug, sessionId, {
    hasUnreadNotifications: false,
  })
}

/** Hook form of {@link clearSessionUnreadInCache}, bound to the active client. */
export function useClearSessionUnread() {
  const queryClient = useQueryClient()
  return useCallback(
    (agentSlug: string, sessionId: string) => clearSessionUnreadInCache(queryClient, agentSlug, sessionId),
    [queryClient],
  )
}

export function useForkSession() {
  const queryClient = useQueryClient()
  const draftsStore = useDraftsStore()
  const { track } = useAnalyticsTracking()

  return useMutation({
    mutationFn: async ({ sessionId, agentSlug }: { sessionId: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/fork`, { method: 'POST' })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let message = 'Failed to fork session'
        try {
          const body = JSON.parse(text) as { error?: string }
          if (body.error) message = body.error
        } catch {
          if (text.trim()) message = text
        }
        throw new Error(message)
      }
      return res.json() as Promise<ApiSession>
    },
    onMutate: ({ sessionId }) => ({ draft: snapshotSessionDraft(draftsStore, sessionId) }),
    onError: (error) => {
      track('session_fork_failed', { reason: error instanceof Error ? error.message : 'unknown' })
    },
    onSuccess: (fork, variables, context) => {
      track('session_forked')
      queryClient.setQueryData(['session', fork.id, fork.agentSlug], fork)
      seedSessionDraft(draftsStore, fork.id, context.draft)
      queryClient.invalidateQueries({
        queryKey: ['sessions', resolveAgentSlugFromCache(queryClient, variables.agentSlug)],
      })
    },
  })
}

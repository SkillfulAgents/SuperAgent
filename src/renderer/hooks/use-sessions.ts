import { invalidateNotificationCaches } from '@renderer/lib/notification-read-cache'
import { apiFetch, apiJson } from '@renderer/lib/api'
import { readAgentRuntimeError } from '@shared/lib/agent-runtime-errors/agent-runtime-request-error'
import { useCallback, useSyncExternalStore } from 'react'
import { useQuery, useMutation, useQueryClient, hashKey, skipToken, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { z } from 'zod'
import { RECENT_SESSIONS_LIMIT, recentSessionsKey, seedCreatedSessionInRecent, sessionTotalKey, writeFullListToRecent } from '@renderer/lib/agent-cache'
import { useNavigate } from '@tanstack/react-router'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { copyComposerDraft, sessionDraftKey, useDraftsStore } from '@renderer/context/drafts-context'
import { useSendMessage } from '@renderer/hooks/use-messages'
import { useResolvedAgentId, resolveRouteAgentId, type ApiAgent } from '@renderer/hooks/use-agents'
import { applySessionActivityStatus, patchSessionInCaches, removeSessionFromCaches } from '@renderer/lib/agent-cache'
import type { ApiSession } from '@shared/lib/types/api'
import type { RuntimeOptions } from '@shared/lib/container/runtime-options'
import type { SessionDashboardDispatch } from '@shared/lib/dashboard-dispatch-schema'
import { TODOS_QUERY_KEY } from './todos-query-key'

// Re-export for convenience
export type { ApiSession }

// Session caches are keyed by the CANONICAL agent id so a given agent's sessions
// land on ONE cache entry — the URL carries the decorative display slug
// (`{name}-{id}`) while the sidebar, mutations and SSE invalidations all key on
// the bare id. Resolving every slug form through the loaded agents list before it
// reaches a query key is what stops the same session list/entry from splitting in
// two (one stale half that invalidations never reach). The agents query is
// shared (deduped) so this adds no real fetch cost, and the resolution is a
// narrow subscription: every sidebar row calls `useSessions`, collapsed or not.
function useResolvedAgentSlug(agentSlug: string | null): string | null {
  return useResolvedAgentId(agentSlug ?? undefined) ?? null
}

/** One-shot resolution for mutation invalidations, reading the cached agents list. */
function resolveAgentSlugFromCache(queryClient: QueryClient, agentSlug: string): string {
  const agents = queryClient.getQueryData<ApiAgent[]>(['agents'])
  return resolveRouteAgentId(agentSlug, agents) ?? agentSlug
}

/**
 * Every session of an agent. Shared by every reader of ['sessions', slug], so
 * each read also brings the sidebar's recent slice up to date
 * (`writeFullListToRecent`). `slug` is the canonical agent id.
 */
export function allSessionsQueryOptions(queryClient: QueryClient, slug: string | null) {
  return {
    queryKey: ['sessions', slug],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ApiSession[]> => {
      const res = await apiFetch(`/api/agents/${slug}/sessions`, { signal })
      if (!res.ok) throw new Error('Failed to fetch sessions')
      const sessions = await res.json() as ApiSession[]
      // A read an invalidation replaced must not write its older rows into the slice.
      if (signal.aborted) throw signal.reason
      if (slug) writeFullListToRecent(queryClient, slug, sessions)
      return sessions
    },
  }
}

export function useSessions(agentSlug: string | null, options?: { staleTime?: number }) {
  const resolvedSlug = useResolvedAgentSlug(agentSlug)
  const queryClient = useQueryClient()
  return useQuery<ApiSession[]>({
    ...allSessionsQueryOptions(queryClient, resolvedSlug),
    enabled: !!resolvedSlug,
    // Unset stays unset: an explicit `staleTime: undefined` replaces the client's default with 0.
    ...(options?.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
  })
}

/**
 * Notable-only slice (live or carrying unread notifications) for badge and
 * toolbar consumers. The full list makes the server read every entry of the
 * agent's session index — 20k rows for a 20k-session agent — where this
 * path reads only the handful of notable ids. Keyed under the same
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
    // Unset stays unset: an explicit `staleTime: undefined` replaces the client's default with 0.
    ...(options?.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
  })
}

/**
 * The sidebar's read of an agent's sessions: the newest few rows and how many
 * there are, in one bounded request. An unlimited read answers every session
 * and, in auth mode, looks up the participants of every one; a row shows five.
 *
 * Shared by the row's query and its hover prefetch, so both land on one key.
 * `slug` is the canonical agent id. The count goes to its own cache entry
 * (`useSessionTotal`): the list entry stays a plain array, the shape every
 * cache updater of session lists patches.
 */
export function recentSessionsQueryOptions(queryClient: QueryClient, slug: string | null) {
  return {
    queryKey: recentSessionsKey(slug),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ApiSession[]> => {
      const res = await apiFetch(`/api/agents/${slug}/sessions?limit=${RECENT_SESSIONS_LIMIT}&with_total=true`, { signal })
      if (!res.ok) throw new Error('Failed to fetch sessions')
      const body = recentSessionsResponseSchema.parse(await res.json())
      // The count is written here, beside the read rather than through it, so
      // a read the query has dropped (an invalidation restarts it) must not
      // write: its reply can land after the newer read's and undo its count.
      if (signal.aborted) throw signal.reason
      // A server from before `with_total` answers the limited rows alone.
      if (Array.isArray(body)) {
        queryClient.removeQueries({ queryKey: sessionTotalKey(slug), exact: true })
        return body as ApiSession[]
      }
      queryClient.setQueryData(sessionTotalKey(slug), body.total)
      return body.sessions as ApiSession[]
    },
  }
}

const recentSessionsResponseSchema = z.union([
  z.array(z.unknown()),
  z.object({ sessions: z.array(z.unknown()), total: z.number() }),
])

/**
 * The recent slice, read for itself only while no view keeps the agent's full
 * list live (the agent's home, its sessions page, "Show all", search). While
 * one does, that list's reads write the slice (`writeFullListToRecent`), so
 * an event costs one request, not one per list, and leaving that view shows
 * the newest rows at once. A slice with no rows yet reads once regardless.
 */
export function useRecentSessions(agentSlug: string | null) {
  const resolvedSlug = useResolvedAgentSlug(agentSlug)
  const queryClient = useQueryClient()
  const fullListLive = useQueryIsLive(resolvedSlug ? ['sessions', resolvedSlug] : null)
  return useQuery<ApiSession[]>({
    ...recentSessionsQueryOptions(queryClient, resolvedSlug),
    enabled: (query) => !!resolvedSlug && (!fullListLive || query.state.data === undefined),
  })
}

/**
 * Whether a mounted reader keeps the query at `queryKey` fetching (an enabled
 * observer), so its invalidations refetch it. Re-renders only when that flips.
 */
function useQueryIsLive(queryKey: QueryKey | null): boolean {
  const queryCache = useQueryClient().getQueryCache()
  const queryHash = queryKey ? hashKey(queryKey) : null
  const subscribe = useCallback((onChange: () => void) => (
    queryHash === null
      ? () => {}
      : queryCache.subscribe((event) => {
          if (event.query.queryHash === queryHash) onChange()
        })
  ), [queryCache, queryHash])
  const isLive = () => (queryHash === null ? false : queryCache.get(queryHash)?.isActive() ?? false)
  return useSyncExternalStore(subscribe, isLive, isLive)
}

/**
 * How many sessions the agent lists, as its last recent-slice read reported
 * it; undefined until one has, or when the server does not report it. Never
 * fetches: `recentSessionsQueryOptions` writes it.
 */
export function useSessionTotal(agentSlug: string | null): number | undefined {
  const resolvedSlug = useResolvedAgentSlug(agentSlug)
  return useQuery<number>({ queryKey: sessionTotalKey(resolvedSlug), queryFn: skipToken }).data
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

export function useCreateSession(options: {
  /** The caller renders AgentRuntimeErrors that have a preview, so skip their toast. */
  agentRuntimeErrorsShownInline?: boolean
  /** The caller shows every failure itself, so skip the global error toast. */
  skipGlobalErrorToast?: boolean
} = {}) {
  const queryClient = useQueryClient()
  const { track } = useAnalyticsTracking()

  return useMutation({
    meta: { agentRuntimeErrorsShownInline: options.agentRuntimeErrorsShownInline, skipGlobalErrorToast: options.skipGlobalErrorToast },
    mutationFn: async (data: {
      agentSlug: string
      message: string
      // Names the session instead of generating a name from the message.
      name?: string
      // Provenance for sessions confirmed via a dashboard's dispatch dialog.
      dashboardDispatch?: SessionDashboardDispatch
      // The launcher's computer-use toggle: the session may use any app without asking.
      computerUse?: boolean
      // Analytics-only: distinguishes auto-started sessions (template onboarding,
      // todo dispatch) from user-typed ones. Not sent to the server.
      origin?: 'user' | 'onboarding' | 'todo'
      // Analytics-only: the session was started from a voice entry point.
      inputMode?: 'voice'
      // Analytics-only: the UI that started the session when it is not the agent's composer.
      surface?: 'quick_dispatch' | 'dashboard_comment'
    } & RuntimeOptions) => {
      const res = await apiFetch(`/api/agents/${data.agentSlug}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: data.message,
          ...(data.name ? { name: data.name } : {}),
          ...(data.effort ? { effort: data.effort } : {}),
          ...(data.speed ? { speed: data.speed } : {}),
          ...(data.model ? { model: data.model } : {}),
          ...(data.llmProviderId !== undefined ? { llmProviderId: data.llmProviderId } : {}),
          ...(data.dashboardDispatch ? { dashboardDispatch: data.dashboardDispatch } : {}),
          ...(data.computerUse ? { computerUse: true } : {}),
        }),
      })
      if (!res.ok) throw await readAgentRuntimeError(res, 'Failed to create session')
      // initialMessageUuid is the server-assigned id of the initial message,
      // used to materialize the optimistic pending copy by exact id match.
      return res.json() as Promise<ApiSession & { initialMessageUuid: string; credentialSource?: string }>
    },
    onSuccess: (created, variables) => {
      const origin = variables.origin ?? 'user'
      // Onboarding and todo auto-sends are neither typed nor spoken, so they stay unstamped.
      const inputMode = variables.inputMode ?? (origin === 'user' ? 'text' : undefined)
      const stamp = {
        origin,
        ...(variables.surface ? { surface: variables.surface } : {}),
        ...(variables.computerUse ? { computer_use: true } : {}),
      }
      track('session_created', { ...stamp, ...(inputMode ? { input_mode: inputMode } : {}) })
      // A voice-started session's first message is the entry marker, not something the person said.
      track('message_sent', {
        ...stamp,
        session_id: created.id,
        credential_source: created.credentialSource ?? 'unknown',
        ...(inputMode ? { input_mode: inputMode === 'voice' ? 'voice_notice' : inputMode } : {}),
      })
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
      seedCreatedSessionInRecent(queryClient, resolvedSlug, created)
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
      const resolvedSlug = resolveAgentSlugFromCache(queryClient, variables.agentSlug)
      removeSessionFromCaches(queryClient, resolvedSlug, variables.id)
      invalidateNotificationCaches(queryClient, resolvedSlug, { deletedSessionId: variables.id })
      // A Todo item started in it lets go of it on the server.
      queryClient.invalidateQueries({ queryKey: TODOS_QUERY_KEY })
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
      // A started Todo card shows its session's name.
      queryClient.invalidateQueries({ queryKey: TODOS_QUERY_KEY })
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
      // that was never set. Refetching on that no-op would re-read every
      // session of the agent (the sessions list) and re-enrich
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
    hasUnreadMention: false,
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
  const navigate = useNavigate()
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
    // The source's draft as it is at the click: the fork's id does not exist until the request returns.
    onMutate: ({ sessionId }) => ({ draft: draftsStore.get(sessionDraftKey(sessionId)) }),
    onError: (error) => {
      console.error('Failed to fork session:', error)
      track('session_fork_failed', { reason: error instanceof Error ? error.message : 'unknown' })
    },
    onSuccess: (fork, variables, context) => {
      track('session_forked')
      queryClient.setQueryData(['session', fork.id, fork.agentSlug], fork)
      copyComposerDraft(draftsStore, sessionDraftKey(fork.id), context.draft)
      queryClient.invalidateQueries({
        queryKey: ['sessions', resolveAgentSlugFromCache(queryClient, variables.agentSlug)],
      })
      // Open the copy. Returned so the mutation resolves only once the route
      // transition is done and a caller that acts next does so from inside it.
      return navigate({
        to: '/agents/$slug/sessions/$sessionId',
        params: { slug: variables.agentSlug, sessionId: fork.id },
      })
    },
  })
}

/**
 * Fork, open the copy, then compact the copy. The source is never mutated.
 * useForkSession opens the copy before it resolves, so the user watches the
 * compaction from inside the copy.
 */
export function useForkAndCompact() {
  const forkSession = useForkSession()
  const sendMessage = useSendMessage()
  return useMutation({
    // Both inner mutations already log and toast their own failures, so this
    // one skips the global error toast.
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ sessionId, agentSlug }: { sessionId: string; agentSlug: string }) => {
      const fork = await forkSession.mutateAsync({ sessionId, agentSlug })
      await sendMessage.mutateAsync({ sessionId: fork.id, agentSlug: fork.agentSlug, content: '/compact' })
    },
  })
}

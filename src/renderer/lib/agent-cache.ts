import type { Query, QueryClient, QueryKey } from '@tanstack/react-query'
import type { ApiAgent, ApiAgentWidget, ApiSession } from '@shared/lib/types/api'
import type { ArtifactInfo } from '@renderer/hooks/use-artifacts'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'

export function updateAgentAvatarCache(queryClient: QueryClient, slug: string, avatar: AgentAvatar): void {
  updateMatchingAgents(queryClient, slug, (agent) => ({ ...agent, avatar }))
}

function matchesAgent(agent: ApiAgent, slug: string): boolean {
  return agent.slug === slug || agent.displaySlug === slug
}

function updateMatchingAgents(
  queryClient: QueryClient,
  slug: string,
  update: (agent: ApiAgent) => ApiAgent,
): void {
  queryClient.setQueryData<ApiAgent[]>(['agents'], (agents) => (
    agents?.map((agent) => matchesAgent(agent, slug) ? update(agent) : agent)
  ))
  queryClient.setQueriesData<ApiAgent>(
    {
      predicate: (query) => query.queryKey[0] === 'agents' && query.queryKey.length === 2,
    },
    (agent) => agent && matchesAgent(agent, slug) ? update(agent) : agent,
  )
}

/** Apply a pushed/command runtime transition without refetching agent summaries. */
export function updateAgentRuntimeCache(
  queryClient: QueryClient,
  slug: string,
  status: ApiAgent['status'],
  containerPort?: number | null,
): void {
  updateMatchingAgents(queryClient, slug, (agent) => ({
    ...agent,
    status,
    containerPort: status === 'stopped'
      ? null
      : containerPort === undefined
        ? agent.containerPort
        : containerPort,
    // A stop clears the host's stale mark. A running write keeps it: a warm
    // start of a running agent leaves the host's mark in place, and the rare
    // start after a silent host-side stop corrects itself on the next list fetch.
    ...(status === 'stopped' ? { stale: undefined } : {}),
  }))
  // The global settings carry `hasRunningAgents`, which locks Settings →
  // Runtime. Mark them stale without a request, so the next screen that opens
  // them reads again instead of trusting the cache for its staleTime.
  void queryClient.invalidateQueries({ queryKey: ['settings'], exact: true, refetchType: 'none' })
}

/** All slugs an agent's per-agent queries may be keyed by (canonical + decorative). */
function agentSlugAliases(queryClient: QueryClient, slug: string): Set<string> {
  const aliases = new Set([slug])
  let found = false
  const addAliases = (agent: ApiAgent | undefined) => {
    if (!agent || !matchesAgent(agent, slug)) return
    found = true
    aliases.add(agent.slug)
    if (agent.displaySlug) aliases.add(agent.displaySlug)
  }
  queryClient.getQueryData<ApiAgent[]>(['agents'])?.forEach(addAliases)
  // The list is the usual source; the full-cache walk over detail entries is
  // only a fallback for the window before the list has loaded.
  if (found) return aliases
  for (const [, agent] of queryClient.getQueriesData<ApiAgent>({
    predicate: (query) => query.queryKey[0] === 'agents' && query.queryKey.length === 2,
  })) {
    addAliases(agent)
  }
  return aliases
}

/** The keys one agent's detail may be cached under: its canonical id and decorative route aliases. */
export function agentDetailQueryKeys(queryClient: QueryClient, slug: string): QueryKey[] {
  return [...agentSlugAliases(queryClient, slug)].map((alias) => ['agents', alias])
}

/** Invalidate artifact queries for one agent, including decorative route aliases. */
export function invalidateAgentArtifacts(queryClient: QueryClient, slug: string): void {
  const aliases = agentSlugAliases(queryClient, slug)
  queryClient.invalidateQueries({
    predicate: (query) => (
      query.queryKey[0] === 'artifacts'
      && typeof query.queryKey[1] === 'string'
      && aliases.has(query.queryKey[1])
    ),
  })
}

/**
 * Apply a pushed dashboard startup outcome directly to cached artifact lists,
 * so the dashboard view flips without waiting for its next poll. Entries not
 * present yet are left to the accompanying invalidation's refetch.
 */
export function applyDashboardRuntimeStatus(
  queryClient: QueryClient,
  agentSlug: string,
  dashboardSlug: string,
  status: ArtifactInfo['status'],
): void {
  const aliases = agentSlugAliases(queryClient, agentSlug)
  queryClient.setQueriesData<ArtifactInfo[]>(
    {
      predicate: (query) => (
        query.queryKey[0] === 'artifacts'
        && typeof query.queryKey[1] === 'string'
        && aliases.has(query.queryKey[1])
      ),
    },
    (artifacts) => artifacts?.map((artifact) => (
      artifact.slug === dashboardSlug ? { ...artifact, status } : artifact
    )),
  )
}

/** Session status flags with an optimistic local echo, and their agent rollups. */
const SESSION_ROLLUP_FLAGS = [
  ['isActive', 'hasActiveSessions'],
  ['isAwaitingInput', 'hasSessionsAwaitingInput'],
  ['hasUnreadNotifications', 'hasUnreadNotifications'],
  ['hasUnreadMention', 'hasUnreadMention'],
] as const

export type SessionStatusPatch = Partial<
  Pick<ApiSession, 'isActive' | 'isAwaitingInput' | 'hasUnreadNotifications' | 'hasUnreadMention'>
>

// Identity-preserving apply. Change detection iterates the PATCH's own keys —
// not SESSION_ROLLUP_FLAGS — so widening SessionStatusPatch with a field that
// lacks a rollup row can never silently drop the field from the write.
function withStatusPatch(session: ApiSession, patch: SessionStatusPatch): ApiSession {
  const changed = (Object.keys(patch) as (keyof SessionStatusPatch)[])
    .some((flag) => (session[flag] ?? false) !== patch[flag])
  return changed ? { ...session, ...patch } : session
}

function isAgentSessionListKey(queryKey: readonly unknown[], aliases: Set<string>): boolean {
  return queryKey[0] === 'sessions'
    && typeof queryKey[1] === 'string'
    && aliases.has(queryKey[1])
}

/**
 * How many sessions the sidebar asks for: the five an agent's row shows, and
 * one more so a reply cut at the limit is told apart from the whole list.
 */
export const RECENT_SESSIONS_LIMIT = 6

/**
 * The sidebar's slice of an agent's sessions: the newest few, in the full
 * list's order. Under the ['sessions', slug] prefix like every other session
 * list, so the invalidations and the patches below reach it.
 */
export function recentSessionsKey(agentSlug: string | null): QueryKey {
  return ['sessions', agentSlug, 'recent', RECENT_SESSIONS_LIMIT]
}

/** How many sessions the agent lists in all, as the last recent-slice read reported it. */
export function sessionTotalKey(agentSlug: string | null): QueryKey {
  return ['session-total', agentSlug]
}

function isRecentSessionsKey(queryKey: readonly unknown[]): boolean {
  return queryKey.length === 4 && queryKey[2] === 'recent'
}

/**
 * Put a session this tab just created at the head of the agent's cached recent
 * slice, as the create mutation does for the full list, so its sidebar row is
 * there at once; the refetch behind it stays authoritative.
 */
export function seedCreatedSessionInRecent(queryClient: QueryClient, agentSlug: string, created: ApiSession): void {
  let added = false
  queryClient.setQueryData<ApiSession[]>(recentSessionsKey(agentSlug), (sessions) => {
    if (!sessions || sessions.some((session) => session.id === created.id)) return sessions
    added = true
    return [created, ...sessions].slice(0, RECENT_SESSIONS_LIMIT)
  })
  if (added) {
    queryClient.setQueryData<number>(sessionTotalKey(agentSlug), (total) => (total === undefined ? total : total + 1))
  }
}

/**
 * Carry a read of the agent's full list into its cached recent slice and count.
 * While a view that lists every session is open, the slice does not read for
 * itself (`useRecentSessions`): the full list's reads keep it current, so when
 * that view closes the row goes on from the newest rows the tab has, not from
 * the slice's own older read. Only a slice that is already cached is written
 * (the row that shows it makes it), and a count only where the server reports
 * one: without it the row counts the full list instead.
 */
export function writeFullListToRecent(queryClient: QueryClient, agentSlug: string, sessions: ApiSession[]): void {
  queryClient.setQueryData<ApiSession[]>(recentSessionsKey(agentSlug), (recent) => (
    recent === undefined ? undefined : sessions.slice(0, RECENT_SESSIONS_LIMIT)
  ))
  queryClient.setQueryData<number>(sessionTotalKey(agentSlug), (total) => (total === undefined ? undefined : sessions.length))
}

/**
 * The cached lists that can vouch for clearing an agent rollup, as the rows
 * each holds: no session outside them can still carry the flag.
 *
 * - The full list (['sessions', <alias>], no further key segments).
 * - A recent slice shorter than its limit: nothing was cut, so it is the full
 *   list.
 * - A notable slice shorter than its limit: the server puts every live and
 *   every unread session in it, so under the limit none is missing. Not for
 *   the mention flag, which the slice's membership does not follow, and only
 *   while the slice is settled (see settledSessionLists): a session that went
 *   live since it was read is not in it until the refetch its event started
 *   lands.
 *
 * A slice cut at its limit, and the automation slices (settled sessions, no
 * status flags), vouch for nothing.
 */
function rollupClearAuthorities(
  sessionLists: readonly { query: Query; settled: boolean }[],
  sessionFlag: (typeof SESSION_ROLLUP_FLAGS)[number][0],
): ApiSession[][] {
  return sessionLists.flatMap(({ query, settled }) => {
    const data = query.state.data
    if (!Array.isArray(data)) return []
    const key = query.queryKey
    if (key.length === 2) return [data as ApiSession[]]
    const limit = key[3]
    if (key.length !== 4 || typeof limit !== 'number' || data.length >= limit) return []
    if (key[2] === 'recent') return [data as ApiSession[]]
    if (key[2] === 'notable' && sessionFlag !== 'hasUnreadMention' && settled) return [data as ApiSession[]]
    return []
  })
}

/**
 * An agent's cached session lists, each with whether it is settled: watched,
 * not invalidated and not being read. A watched list is read again as soon as
 * it is invalidated, so a settled one is as current as this tab gets. Taken
 * BEFORE a patch is written, since writing to a query marks it fresh again.
 */
function settledSessionLists(queryClient: QueryClient, aliases: Set<string>): { query: Query; settled: boolean }[] {
  return queryClient
    .getQueryCache()
    .findAll({ predicate: (query) => isAgentSessionListKey(query.queryKey, aliases) })
    .map((query) => ({
      query,
      settled: query.getObserversCount() > 0 && !query.state.isInvalidated && query.state.fetchStatus === 'idle',
    }))
}

/** One cached session list of an agent, and whether it holds a given session. */
export interface SessionListMembership {
  queryKey: QueryKey
  /** The agent's full list, not a slice of it. */
  full: boolean
  /** The full list or the sidebar's recent slice: a list whose rows the tab shows. */
  rows: boolean
  holds: boolean
}

/**
 * Every cached session list of one agent (all route keys and slices), and
 * whether each holds this session. A status event can patch a row in place;
 * only a refetch can add one.
 */
export function sessionListMembership(queryClient: QueryClient, agentSlug: string, sessionId: string): SessionListMembership[] {
  const aliases = agentSlugAliases(queryClient, agentSlug)
  return queryClient
    .getQueriesData<unknown>({ predicate: (query) => isAgentSessionListKey(query.queryKey, aliases) })
    .flatMap(([queryKey, data]) => Array.isArray(data)
      ? [{ queryKey, full: queryKey.length === 2, rows: queryKey.length === 2 || isRecentSessionsKey(queryKey), holds: data.some((entry) => (entry as ApiSession | null)?.id === sessionId) }]
      : [])
}

/**
 * Invalidate the agent's session lists that can hold a hidden automated
 * session. The full list and the notable slice (`useNotableSessions`) come
 * from the sessions route, which leaves those sessions out.
 */
export function invalidateAutomationSessionLists(queryClient: QueryClient, agentSlug: string): void {
  const aliases = agentSlugAliases(queryClient, agentSlug)
  queryClient.invalidateQueries({
    predicate: (query) => isAgentSessionListKey(query.queryKey, aliases) && query.queryKey.length > 2 && query.queryKey[2] !== 'notable',
  })
}

/** Invalidate every cached session list of one agent (all route keys and slices), and no other agent's. */
export function invalidateAgentSessionLists(queryClient: QueryClient, agentSlug: string): void {
  const aliases = agentSlugAliases(queryClient, agentSlug)
  queryClient.invalidateQueries({ predicate: (query) => isAgentSessionListKey(query.queryKey, aliases) })
}

/**
 * A deleted session leaves every cached list of its agent at once, and its
 * detail is dropped rather than read again (the read would 404). A detail a
 * mounted view still observes is kept, marked stale, until that view leaves.
 * Call before invalidating the lists: a write clears a query's stale mark.
 */
export function removeSessionFromCaches(queryClient: QueryClient, agentSlug: string, sessionId: string): void {
  const aliases = agentSlugAliases(queryClient, agentSlug)
  queryClient.setQueriesData<unknown>(
    { predicate: (query) => isAgentSessionListKey(query.queryKey, aliases) },
    (data: unknown) => (
      Array.isArray(data) && data.some((entry) => (entry as ApiSession | null)?.id === sessionId)
        ? data.filter((entry) => (entry as ApiSession | null)?.id !== sessionId)
        : data
    ),
  )
  queryClient.removeQueries({ queryKey: ['session', sessionId], type: 'inactive' })
  void queryClient.invalidateQueries({ queryKey: ['session', sessionId], refetchType: 'none' })
}

/**
 * Patch one session's entry in every cached projection: each list under
 * ['sessions', <alias>] (the full list, the notable slice, automation slices)
 * plus the ['session', id, <alias>] detail entries. One traversal shared by
 * the status echoes, the unread clear, and the rename write-through, so key
 * shapes and slug aliasing can only be fixed in one place.
 *
 * `update` must return the SAME reference when nothing changes; the return
 * value reports whether any cached entry actually changed. Entries the update
 * leaves alone (and lists it never touches) keep their identity via React
 * Query's structural sharing.
 */
export function patchSessionInCaches(
  queryClient: QueryClient,
  agentSlug: string,
  sessionId: string,
  update: (session: ApiSession) => ApiSession,
): boolean {
  return patchSessionWithAliases(queryClient, agentSlugAliases(queryClient, agentSlug), sessionId, update)
}

function patchSessionWithAliases(
  queryClient: QueryClient,
  aliases: Set<string>,
  sessionId: string,
  update: (session: ApiSession) => ApiSession,
): boolean {
  let changed = false
  const applyUpdate = (session: ApiSession): ApiSession => {
    const next = update(session)
    if (next !== session) changed = true
    return next
  }
  // A session not present in a list (e.g. brand-new on its first
  // session_active) is simply not patched — the refetch introduces it.
  queryClient.setQueriesData<unknown>(
    { predicate: (query) => isAgentSessionListKey(query.queryKey, aliases) },
    (data: unknown) => (
      Array.isArray(data)
        ? data.map((entry) => {
            const session = entry as ApiSession | null
            return session && session.id === sessionId ? applyUpdate(session) : entry
          })
        : data
    ),
  )
  // The detail entry's exact keys are known — no cache walk needed.
  for (const alias of aliases) {
    queryClient.setQueryData<ApiSession>(['session', sessionId, alias], (session) => (
      session ? applyUpdate(session) : session
    ))
  }
  return changed
}

/**
 * Optimistic local echo for a session's working / awaiting-input / unread
 * transitions. The session lifecycle events (session_active / session_idle /
 * session_error / session_awaiting_input / session_input_provided) and the
 * unread-affecting notification paths trigger refetches of very different
 * cost (agent session list, agent detail, full agents list), so indicators
 * reading different caches flip seconds apart if they each wait for their own
 * refetch. Patch the flags into every cached projection up front; the
 * accompanying invalidations refetch the authoritative state right behind it
 * and correct any misprediction.
 *
 * Returns whether any cached session entry actually changed (the
 * clearSessionUnreadInCache delegate uses this to tell a real clear from a
 * no-op open).
 */
export function applySessionActivityStatus(
  queryClient: QueryClient,
  agentSlug: string,
  sessionId: string,
  patch: SessionStatusPatch,
): boolean {
  const aliases = agentSlugAliases(queryClient, agentSlug)

  // O(1) relevance gate before any cache walk: the global stream carries
  // lifecycle events for EVERY agent (all of a workspace's sessions — and in
  // the shared-server e2e environment, every parallel worker's traffic). An
  // agent whose session data this tab never cached has nothing to patch, and
  // its rollup clears could not be validated anyway — its sidebar row keeps
  // the refetch-driven cadence. Without this, every foreign event pays
  // full-cache predicate walks plus an agents-list rebuild in every open tab.
  const hasSessionData = [...aliases].some((alias) =>
    queryClient.getQueryData(['sessions', alias]) !== undefined
    // The sidebar's slice is a list of rows like the full one, under one known key.
    || queryClient.getQueryData(recentSessionsKey(alias)) !== undefined
    || queryClient.getQueryData(['session', sessionId, alias]) !== undefined,
  )
  if (!hasSessionData) return false

  const hasClear = Object.values(patch).some((value) => value === false)
  const sessionLists = hasClear ? settledSessionLists(queryClient, aliases) : []

  const changed = patchSessionWithAliases(
    queryClient,
    aliases,
    sessionId,
    (session) => withStatusPatch(session, patch),
  )

  // Agent-level rollups. Raising is always safe — one working/awaiting/unread
  // session implies the flag. Clearing consults ONLY the lists that can vouch
  // for it (see rollupClearAuthorities): the full list, and a slice the
  // server did not cut. A slice cut at its limit and the automation slices
  // (settled sessions with no status flags) could approve a clear they cannot
  // actually vouch for. Such a list must be cached at all, and no OTHER
  // session in it may still carry the flag.
  //
  // Known blind spot, accepted deliberately: hidden automated sessions and
  // sessionless agent-level reviews count toward the server's rollup but
  // never appear in ANY cached list (lists are fetched with excludeAutomated,
  // and reviews have no session). While one is live, a clear here can dip the
  // agent rollup for one round-trip until the accompanying ['agents'] refetch
  // restores it. The client genuinely cannot see those from its caches;
  // carrying rollup state on the events themselves is the fix if that rare
  // flicker ever matters more than the every-turn stagger this echo removes.
  const agentPatch: Partial<ApiAgent> = {}
  for (const [sessionFlag, agentFlag] of SESSION_ROLLUP_FLAGS) {
    const value = patch[sessionFlag]
    if (value === undefined) continue
    if (!value) {
      const authorities = rollupClearAuthorities(sessionLists, sessionFlag)
      if (authorities.length === 0) continue
      if (authorities.some((list) => list.some((entry) => entry?.[sessionFlag]))) continue
    }
    agentPatch[agentFlag] = value
  }
  // A session can only be working or blocked on input inside a running
  // container, so a raise is also proof of the runtime state. Assert it with
  // the same event: the activity label short-circuits to "sleeping" while the
  // container reads 'stopped', so a session that visibly streams tokens would
  // otherwise keep the header pill and agent row asleep until the separate
  // agent_status_changed event lands (or is missed on a stalled global
  // stream) or the next agents refetch. Never lowers — idle/error say nothing
  // about whether the container is still up.
  if (patch.isActive === true || patch.isAwaitingInput === true) {
    agentPatch.status = 'running'
  }
  if (Object.keys(agentPatch).length > 0) {
    // Identity-preserving on purpose: a no-op patch (e.g. session_active for
    // an already-working agent — the common case) must return the same agent
    // reference, or every event rebuilds the agents array and pays a full
    // deep-compare in structural sharing.
    // Only the flags that change are written, so a clear adds no `false` an agent never carried.
    updateMatchingAgents(queryClient, agentSlug, (agent) => {
      const changedKeys = (Object.keys(agentPatch) as (keyof ApiAgent)[]).filter((key) => (
        (agent[key] ?? false) !== agentPatch[key]
      ))
      return changedKeys.length > 0
        ? { ...agent, ...Object.fromEntries(changedKeys.map((key) => [key, agentPatch[key]])) }
        : agent
    })
  }
  return changed
}

/** Mark one dashboard thumbnail ready in every cached projection of its agent. */
export function markDashboardScreenshotReady(
  queryClient: QueryClient,
  agentSlug: string,
  dashboardSlug: string,
): void {
  updateMatchingAgents(queryClient, agentSlug, (agent) => {
    if (!agent.dashboards?.some((dashboard) => dashboard.slug === dashboardSlug)) return agent
    return {
      ...agent,
      dashboards: agent.dashboards.map((dashboard) => (
        dashboard.slug === dashboardSlug
          ? { ...dashboard, hasScreenshot: true }
          : dashboard
      )),
    }
  })
}

/**
 * Apply a partial update to one widget everywhere it is cached: the agents
 * list, agent detail entries, and the per-agent ['widgets', slug] query.
 * Used by the widget SSE events so a refresh flips the card without a
 * full agents-list refetch.
 */
export function patchAgentWidget(
  queryClient: QueryClient,
  agentSlug: string,
  widgetSlug: string,
  patch: Partial<ApiAgentWidget>,
): void {
  const apply = (widgets: ApiAgentWidget[] | undefined) => (
    widgets?.map((widget) => (widget.slug === widgetSlug ? { ...widget, ...patch } : widget))
  )
  updateMatchingAgents(queryClient, agentSlug, (agent) => (
    agent.widgets?.some((widget) => widget.slug === widgetSlug)
      ? { ...agent, widgets: apply(agent.widgets) }
      : agent
  ))
  const aliases = agentSlugAliases(queryClient, agentSlug)
  queryClient.setQueriesData<ApiAgentWidget[]>(
    {
      predicate: (query) => (
        query.queryKey[0] === 'widgets'
        && typeof query.queryKey[1] === 'string'
        && aliases.has(query.queryKey[1])
      ),
    },
    apply,
  )
}

/** Refetch the authoritative widget listing for one agent (all route aliases). */
export function invalidateAgentWidgets(queryClient: QueryClient, slug: string): void {
  const aliases = agentSlugAliases(queryClient, slug)
  queryClient.invalidateQueries({
    predicate: (query) => (
      query.queryKey[0] === 'widgets'
      && typeof query.queryKey[1] === 'string'
      && aliases.has(query.queryKey[1])
    ),
  })
}

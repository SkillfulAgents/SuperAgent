import type { QueryClient } from '@tanstack/react-query'
import type { ApiAgent, ApiSession } from '@shared/lib/types/api'
import type { ArtifactInfo } from '@renderer/hooks/use-artifacts'

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
  }))
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
] as const

export type SessionStatusPatch = Partial<
  Pick<ApiSession, 'isActive' | 'isAwaitingInput' | 'hasUnreadNotifications'>
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
    || queryClient.getQueryData(['session', sessionId, alias]) !== undefined,
  )
  if (!hasSessionData) return false

  const changed = patchSessionWithAliases(
    queryClient,
    aliases,
    sessionId,
    (session) => withStatusPatch(session, patch),
  )

  // Agent-level rollups. Raising is always safe — one working/awaiting/unread
  // session implies the flag. Clearing consults ONLY the authoritative full
  // lists (['sessions', <alias>], no extra key segments): the notable slice
  // is truncated server-side and the automation slices hold settled sessions
  // with no status flags, so any of them could approve a clear it cannot
  // actually vouch for. A full list must be cached at all, and no OTHER
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
  const hasClear = Object.values(patch).some((value) => value === false)
  const fullLists = hasClear
    ? queryClient
        .getQueriesData<unknown>({
          predicate: (query) =>
            query.queryKey.length === 2 && isAgentSessionListKey(query.queryKey, aliases),
        })
        .map(([, data]) => data)
        .filter((data): data is ApiSession[] => Array.isArray(data))
    : []
  const agentPatch: Partial<ApiAgent> = {}
  for (const [sessionFlag, agentFlag] of SESSION_ROLLUP_FLAGS) {
    const value = patch[sessionFlag]
    if (value === undefined) continue
    if (!value) {
      if (fullLists.length === 0) continue
      if (fullLists.some((list) => list.some((entry) => entry?.[sessionFlag]))) continue
    }
    agentPatch[agentFlag] = value
  }
  if (Object.keys(agentPatch).length > 0) {
    // Identity-preserving on purpose: a no-op patch (e.g. session_active for
    // an already-working agent — the common case) must return the same agent
    // reference, or every event rebuilds the agents array and pays a full
    // deep-compare in structural sharing.
    updateMatchingAgents(queryClient, agentSlug, (agent) => {
      const rollupChanged = SESSION_ROLLUP_FLAGS.some(([, agentFlag]) => (
        agentPatch[agentFlag] !== undefined && (agent[agentFlag] ?? false) !== agentPatch[agentFlag]
      ))
      return rollupChanged ? { ...agent, ...agentPatch } : agent
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

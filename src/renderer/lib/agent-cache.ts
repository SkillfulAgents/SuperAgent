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
  const addAliases = (agent: ApiAgent | undefined) => {
    if (!agent || !matchesAgent(agent, slug)) return
    aliases.add(agent.slug)
    aliases.add(agent.displaySlug)
  }
  queryClient.getQueryData<ApiAgent[]>(['agents'])?.forEach(addAliases)
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

function patchSessionEntry(session: ApiSession, patch: SessionStatusPatch): ApiSession {
  const changed = SESSION_ROLLUP_FLAGS.some(([flag]) => (
    patch[flag] !== undefined && (session[flag] ?? false) !== patch[flag]
  ))
  return changed ? { ...session, ...patch } : session
}

/**
 * Optimistic local echo for a session's working / awaiting-input / unread
 * transitions. The session lifecycle events (session_active / session_idle /
 * session_error / session_awaiting_input / session_input_provided) and the
 * unread-raising notification events trigger refetches of very different cost
 * (agent session list, agent detail, full agents list), so indicators reading
 * different caches flip seconds apart if they each wait for their own
 * refetch. Patch the flags into every cached projection up front; the
 * accompanying invalidations refetch the authoritative state right behind it
 * and correct any misprediction. (The unread CLEAR direction stays with
 * clearSessionUnreadInCache, which is driven by session opens, not events.)
 */
export function applySessionActivityStatus(
  queryClient: QueryClient,
  agentSlug: string,
  sessionId: string,
  patch: SessionStatusPatch,
): void {
  const aliases = agentSlugAliases(queryClient, agentSlug)
  const isAgentSessionListKey = (queryKey: readonly unknown[]) =>
    queryKey[0] === 'sessions'
    && typeof queryKey[1] === 'string'
    && aliases.has(queryKey[1])

  // Session lists under the agent: the full list plus the notable slice. A
  // session not present yet (e.g. brand-new on its first session_active) is
  // simply not patched — the refetch introduces it.
  let sawSessionList = false
  queryClient.setQueriesData<unknown>(
    { predicate: (query) => isAgentSessionListKey(query.queryKey) },
    (data: unknown) => {
      if (!Array.isArray(data)) return data
      sawSessionList = true
      let changed = false
      const next = data.map((entry) => {
        const session = entry as ApiSession | null
        if (!session || session.id !== sessionId) return entry
        const patched = patchSessionEntry(session, patch)
        changed ||= patched !== session
        return patched
      })
      return changed ? next : data
    },
  )

  // The single-session entry (keyed ['session', id, <any slug alias>]).
  queryClient.setQueriesData<ApiSession>(
    { predicate: (query) => query.queryKey[0] === 'session' && query.queryKey[1] === sessionId },
    (session) => (session ? patchSessionEntry(session, patch) : session),
  )

  // Agent-level rollups. Raising is always safe — one working/awaiting
  // session implies the flag. Clearing needs the patched lists to show no
  // OTHER session still carrying the flag, and at least one list must be
  // cached at all: with no local session data an unseen sibling session could
  // still hold the rollup up, so that case is left to the refetch.
  const sessionLists = queryClient
    .getQueriesData<unknown>({ predicate: (query) => isAgentSessionListKey(query.queryKey) })
  const agentPatch: Partial<ApiAgent> = {}
  for (const [sessionFlag, agentFlag] of SESSION_ROLLUP_FLAGS) {
    const value = patch[sessionFlag]
    if (value === undefined) continue
    if (!value) {
      if (!sawSessionList) continue
      const siblingHasFlag = sessionLists.some(([, data]) =>
        Array.isArray(data)
        && data.some((entry) => (entry as ApiSession | null)?.[sessionFlag]),
      )
      if (siblingHasFlag) continue
    }
    agentPatch[agentFlag] = value
  }
  if (Object.keys(agentPatch).length === 0) return
  updateMatchingAgents(queryClient, agentSlug, (agent) => {
    const changed = SESSION_ROLLUP_FLAGS.some(([, agentFlag]) => (
      agentPatch[agentFlag] !== undefined && (agent[agentFlag] ?? false) !== agentPatch[agentFlag]
    ))
    return changed ? { ...agent, ...agentPatch } : agent
  })
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

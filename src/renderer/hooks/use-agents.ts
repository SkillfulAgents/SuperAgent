import { useCallback } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import type { ApiAgent } from '@shared/lib/types/api'
import { updateAgentAvatarCache, updateAgentRuntimeCache } from '@renderer/lib/agent-cache'
import { agentAvatarSchema, type AgentAvatar } from '@shared/lib/types/agent-avatar'
import { TODOS_QUERY_KEY } from './todos-query-key'
import { usePreparedTeamBrainSlug } from '@renderer/lib/team-brain/team-brain-store'
import { experimentEnabled } from '@shared/lib/experiments'
import { useUserSettings } from './use-user-settings'

// Re-export for convenience
export type { ApiAgent }

// Mirrors the host's minted-id shape ([a-z0-9]{10}). Kept local because the
// shared file-storage module pulls in `fs` and can't be imported in the renderer.
const MINTED_AGENT_ID_RE = /^[a-z0-9]{10}$/

/**
 * Resolve an agent route param — which may be a display slug (`{name}-{id}`), a
 * bare id, or a legacy folder id — to the canonical agent id, using the loaded
 * agents list. The URL carries the decorative display slug, but every in-app
 * comparison keys on the stable id, so route-derived active/selection state must
 * be resolved through here rather than comparing the raw param to `agent.slug`.
 *
 * Matches on the trailing minted id (not just the exact current displaySlug) so
 * selection stays stable when the URL slug goes stale — e.g. a brand-new agent
 * navigated to as `untitled-{id}` and then auto-renamed to `{name}-{id}` (the URL
 * isn't canonicalized). Mirrors the host `resolveAgentId`. Falls back to the raw
 * input when the list isn't ready or nothing matches.
 */
export function resolveRouteAgentId(
  slug: string | undefined,
  agents: Pick<ApiAgent, 'slug' | 'displaySlug'>[] | undefined,
): string | undefined {
  if (!slug) return undefined
  const dash = slug.lastIndexOf('-')
  const tail = dash === -1 ? slug : slug.slice(dash + 1)
  const trailingId = MINTED_AGENT_ID_RE.test(tail) ? tail : undefined
  const match = agents?.find(
    (a) => a.slug === slug || a.displaySlug === slug || a.slug === trailingId,
  )
  return match?.slug ?? slug
}

// Every sidebar row resolves the route's agent and its own sessions' key, and
// so does each of its session and dashboard sub-items. Resolve once per agents
// list per slug, not once per asker: each `['agents']` refetch would otherwise
// rescan the list once per row.
const resolvedAgentIds = new WeakMap<ApiAgent[], Map<string, string>>()

function resolveCached(slug: string, agents: ApiAgent[]): string {
  let bySlug = resolvedAgentIds.get(agents)
  if (!bySlug) resolvedAgentIds.set(agents, (bySlug = new Map()))
  let id = bySlug.get(slug)
  if (id === undefined) bySlug.set(slug, (id = resolveRouteAgentId(slug, agents) ?? slug))
  return id
}

/**
 * Hook form of {@link resolveRouteAgentId} for any slug form.
 *
 * Subscribes through `select`, so a caller re-renders when the resolved id
 * changes, not on every `['agents']` refetch. Every sidebar row calls this, and
 * any agent's session event refetches the list: a whole-list subscription made
 * each event re-render every row, which with hundreds of agents pinned the
 * renderer's main thread.
 */
export function useResolvedAgentId(slug: string | undefined): string | undefined {
  const select = useCallback((agents: ApiAgent[]) => (slug ? resolveCached(slug, agents) : undefined), [slug])
  const { data } = useAgents({ select, poll: false })
  return data ?? resolveRouteAgentId(slug, undefined)
}

/** {@link useResolvedAgentId} for the active `:slug` route param. */
export function useRouteAgentId(): string | undefined {
  const { slug } = useParams({ strict: false }) as { slug?: string }
  return useResolvedAgentId(slug)
}

export function useAgents<TData = ApiAgent[]>(options?: {
  select?: (agents: ApiAgent[]) => TData
  enabled?: boolean
  /** `[]` keeps the list fetched and cached without ever re-rendering the caller. */
  notifyOnChangeProps?: []
  /**
   * `false` for narrow subscriptions mounted once per sidebar row: the list's
   * main consumers keep the fallback poll, and an interval per observer is
   * re-armed on every list update — hundreds of timers per agent event.
   */
  poll?: false
}) {
  return useQuery<ApiAgent[], Error, TData>({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await apiFetch('/api/agents')
      if (!res.ok) throw new Error('Failed to fetch agents')
      return res.json()
    },
    enabled: options?.enabled,
    // React Query structurally shares the `select` result, so a narrow projection
    // (e.g. just {slug, displaySlug} for UserProvider's slug→id resolver) keeps a
    // STABLE reference across the frequent status-only `['agents']` refetches. Without
    // it, every agent-status tick would change `data` identity and re-render every
    // consumer of that projection.
    select: options?.select,
    notifyOnChangeProps: options?.notifyOnChangeProps,
    // Real-time updates via GlobalNotificationHandler, poll as fallback only
    refetchInterval: options?.poll === false ? false : 60000,
  })
}

/** The agents the sidebar and Home list: all but the Team Brain agent, which has its own sidebar item. */
export function useListedAgents() {
  const preparedSlug = usePreparedTeamBrainSlug()
  // With the experiment off it is an ordinary agent again; hidden while settings load, so it never flashes into the list.
  const { data: userSettings, isPending } = useUserSettings()
  const teamBrainOn = isPending || experimentEnabled(userSettings?.experiments, 'team-brain')
  const withoutTeamBrain = useCallback(
    (agents: ApiAgent[]) => agents.filter((agent) => !(teamBrainOn && agent.teamBrain) && agent.slug !== preparedSlug),
    [preparedSlug, teamBrainOn],
  )
  return useAgents({ select: withoutTeamBrain })
}

export function useAgent(slug: string | null) {
  return useQuery<ApiAgent>({
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${slug}`)
      if (!res.ok) throw new Error('Failed to fetch agent')
      return res.json()
    },
    queryKey: ['agents', slug],
    enabled: !!slug,
    // Real-time updates via GlobalNotificationHandler, poll as fallback only
    refetchInterval: 60000,
  })
}

export function useCreateAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (data: { name: string; description?: string }) => {
      const res = await apiFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to create agent')
      return res.json() as Promise<ApiAgent>
    },
    onSuccess: (agent) => {
      // Seed the per-slug cache so consumers reading useAgent(slug) right
      // after navigation (e.g. AgentHome via MainContent) render synchronously
      // instead of flashing through an undefined state while the list query
      // refetches. Create flows navigate to agent.displaySlug, so the loader /
      // useAgent read keys on THAT form — seed it too, or the canonical-id seed
      // is a dead entry and the loader does a cold blocking fetch.
      queryClient.setQueryData(['agents', agent.slug], agent)
      if (agent.displaySlug !== agent.slug) {
        queryClient.setQueryData(['agents', agent.displaySlug], agent)
      }
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
    },
  })
}

export function useDeleteAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (slug: string) => {
      const res = await apiFetch(`/api/agents/${slug}`, { method: 'DELETE' })
      if (!res.ok) {
        // Surface the server's message (e.g. the SUP-209 "container is busy" 409)
        // so the UI can explain why the delete failed, not a generic string.
        const message = await res
          .json()
          .then((d) => (d && typeof d.error === 'string' ? d.error : null))
          .catch(() => null)
        throw new Error(message ?? 'Failed to delete agent')
      }
      // 204 No Content - no body to parse
    },
    onSuccess: (_data, slug) => {
      // Evict the per-slug entry (not just invalidate) so a re-navigation to the
      // just-deleted agent can't be served a stale agent object from cache by the
      // route loader's ensureQueryData(agentQuery(slug)) — which returns a warm
      // entry without a blocking refetch. Defense-in-depth: the server already
      // 404s the agent, so this only removes a brief stale name/description flash.
      queryClient.removeQueries({ queryKey: ['agents', slug] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
      // Todo items given to it let go of it on the server.
      queryClient.invalidateQueries({ queryKey: TODOS_QUERY_KEY })
    },
  })
}

export function useUpdateAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      slug,
      name,
      description,
      instructions,
    }: {
      slug: string
      name?: string
      description?: string
      instructions?: string
    }) => {
      const res = await apiFetch(`/api/agents/${slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, instructions }),
      })
      if (!res.ok) throw new Error('Failed to update agent')
      return res.json() as Promise<ApiAgent>
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents', variables.slug] })
    },
  })
}

export function useUpdateAgentAvatar() {
  const queryClient = useQueryClient()
  const { track } = useAnalyticsTracking()
  return useMutation({
    mutationFn: async ({ slug, avatar }: { slug: string; avatar: AgentAvatar }) => {
      const res = await apiFetch(`/api/agents/${slug}/avatar`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentAvatarSchema.parse(avatar)),
      })
      if (!res.ok) throw new Error('Failed to save avatar')
      return agentAvatarSchema.parse(await res.json())
    },
    onSuccess: (avatar, { slug }) => {
      updateAgentAvatarCache(queryClient, slug, avatar)
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      track('agent_avatar_changed', { color: avatar.color, shape: avatar.shape })
    },
    onError: (_, { avatar }) => {
      track('agent_avatar_change_failed', { color: avatar.color, shape: avatar.shape })
    },
  })
}

export type StartAgentVars = string | {
  slug: string
  source?: 'user' | 'warm-start'
  /**
   * The session the caller is typing into. The server then also resumes that
   * session's agent process if it went idle, so the next send starts sooner.
   */
  sessionId?: string
}

function resolveStartAgentSlug(vars: StartAgentVars): string {
  return typeof vars === 'string' ? vars : vars.slug
}

export function useStartAgent() {
  const queryClient = useQueryClient()
  const { track } = useAnalyticsTracking()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (vars: StartAgentVars) => {
      const slug = resolveStartAgentSlug(vars)
      const sessionId = typeof vars === 'string' ? undefined : vars.sessionId
      const res = await apiFetch(
        `/api/agents/${slug}/start`,
        sessionId
          ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) }
          : { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to start agent')
      }
      return res.json() as Promise<ApiAgent | null>
    },
    onSuccess: (agent, vars) => {
      const source = typeof vars === 'string' ? 'user' : (vars.source ?? 'user')
      // Warm-start is background/speculative — don't inflate agent_started.
      if (source !== 'warm-start') {
        track('agent_started')
      }
      // The command response and agent_status_changed SSE carry the state we
      // need. Keep optional summaries intact instead of refetching them; late
      // dashboard thumbnails arrive through dashboard_screenshot_ready.
      if (agent) {
        updateAgentRuntimeCache(queryClient, agent.slug, agent.status, agent.containerPort)
      } else {
        // A concurrent delete can make the route's identity lookup return null.
        // Preserve the old recovery behavior for that exceptional race.
        const slug = resolveStartAgentSlug(vars)
        queryClient.invalidateQueries({ queryKey: ['agents'] })
        queryClient.invalidateQueries({ queryKey: ['agents', slug] })
      }
    },
  })
}

export function useStopAgent() {
  const queryClient = useQueryClient()
  const { track } = useAnalyticsTracking()

  return useMutation({
    mutationFn: async (slug: string) => {
      const res = await apiFetch(`/api/agents/${slug}/stop`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to stop agent')
      return res.json()
    },
    onSuccess: (_, slug) => {
      track('agent_stopped')
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents', slug] })
    },
  })
}

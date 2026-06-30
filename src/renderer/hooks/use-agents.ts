import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import type { ApiAgent } from '@shared/lib/types/api'

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

/** Hook form of {@link resolveRouteAgentId}, reading the active `:slug` route param. */
export function useRouteAgentId(): string | undefined {
  const { slug } = useParams({ strict: false }) as { slug?: string }
  const { data: agents } = useAgents()
  return resolveRouteAgentId(slug, agents)
}

export function useAgents<TData = ApiAgent[]>(options?: {
  select?: (agents: ApiAgent[]) => TData
}) {
  return useQuery<ApiAgent[], Error, TData>({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await apiFetch('/api/agents')
      if (!res.ok) throw new Error('Failed to fetch agents')
      return res.json()
    },
    // React Query structurally shares the `select` result, so a narrow projection
    // (e.g. just {slug, displaySlug} for UserProvider's slug→id resolver) keeps a
    // STABLE reference across the frequent status-only `['agents']` refetches. Without
    // it, every agent-status tick would change `data` identity and re-render every
    // consumer of that projection.
    select: options?.select,
    // Real-time updates via GlobalNotificationHandler, poll as fallback only
    refetchInterval: 60000,
  })
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

// TODO: GROSS time based rechecks
// Delays (ms) for re-invalidating ['agents'] after an agent starts. The
// container's scanAndStartAll kicks off dashboard startup + screenshot capture
// asynchronously after /start returns, so the first invalidation fires before
// any new screenshot.png lands on disk. These follow-ups pick up the thumbnails
// as they arrive without leaning on a poll loop.
const AGENT_START_REINVALIDATE_DELAYS_MS = [5_000, 15_000, 30_000]

export function useStartAgent() {
  const queryClient = useQueryClient()
  const { track } = useAnalyticsTracking()

  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (slug: string) => {
      const res = await apiFetch(`/api/agents/${slug}/start`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to start agent')
      }
      return res.json()
    },
    onSuccess: (_, slug) => {
      track('agent_started')
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents', slug] })
      for (const delay of AGENT_START_REINVALIDATE_DELAYS_MS) {
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['agents'] })
          queryClient.invalidateQueries({ queryKey: ['agents', slug] })
        }, delay)
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

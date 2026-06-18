import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import type { ApiAgent } from '@shared/lib/types/api'

// Re-export for convenience
export type { ApiAgent }

export function useAgents() {
  return useQuery<ApiAgent[]>({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await apiFetch('/api/agents')
      if (!res.ok) throw new Error('Failed to fetch agents')
      return res.json()
    },
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
      // refetches.
      queryClient.setQueryData(['agents', agent.slug], agent)
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

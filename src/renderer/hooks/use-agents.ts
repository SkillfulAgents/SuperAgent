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
    mutationFn: async (data: { name: string; description?: string }) => {
      const res = await apiFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to create agent')
      return res.json() as Promise<ApiAgent>
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
    },
  })
}

export function useDeleteAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (slug: string) => {
      const res = await apiFetch(`/api/agents/${slug}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete agent')
      // 204 No Content - no body to parse
    },
    onSuccess: () => {
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

/**
 * Webhook Triggers Hooks
 *
 * React Query hooks for managing webhook triggers.
 */

import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { WebhookTrigger } from '@shared/lib/db/schema'

export type { WebhookTrigger }

export function useWebhookTriggers(agentSlug: string | null, status?: 'active' | 'cancelled') {
  return useQuery<WebhookTrigger[]>({
    queryKey: ['webhook-triggers', agentSlug, status],
    queryFn: async () => {
      const url = status
        ? `/api/agents/${agentSlug}/webhook-triggers?status=${status}`
        : `/api/agents/${agentSlug}/webhook-triggers`
      const res = await apiFetch(url)
      if (!res.ok) throw new Error('Failed to fetch webhook triggers')
      return res.json()
    },
    enabled: !!agentSlug,
    refetchInterval: 120_000,
  })
}

export function useWebhookTrigger(triggerId: string | null) {
  return useQuery<WebhookTrigger>({
    queryKey: ['webhook-trigger', triggerId],
    queryFn: async () => {
      const res = await apiFetch(`/api/webhook-triggers/${triggerId}`)
      if (!res.ok) throw new Error('Failed to fetch webhook trigger')
      return res.json()
    },
    enabled: !!triggerId,
    refetchInterval: 120_000,
  })
}

export function useCancelWebhookTrigger() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ triggerId, agentSlug }: { triggerId: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/webhook-triggers/${triggerId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to cancel webhook trigger')
      return { triggerId, agentSlug }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['webhook-triggers', variables.agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['webhook-trigger', variables.triggerId] })
    },
  })
}

interface SessionInfo {
  id: string
  name: string
  createdAt: string
}

export function useWebhookTriggerSessions(triggerId: string | null) {
  return useQuery<SessionInfo[]>({
    queryKey: ['webhook-trigger-sessions', triggerId],
    queryFn: async () => {
      const res = await apiFetch(`/api/webhook-triggers/${triggerId}/sessions`)
      if (!res.ok) throw new Error('Failed to fetch sessions')
      return res.json()
    },
    enabled: !!triggerId,
  })
}

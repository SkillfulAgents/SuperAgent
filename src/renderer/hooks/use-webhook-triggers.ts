/**
 * Webhook Triggers Hooks
 *
 * React Query hooks for managing webhook triggers.
 */

import { apiFetch } from '@renderer/lib/api'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { WebhookTrigger } from '@shared/lib/db/schema'
import {
  useAutomationList,
  useAutomationDetail,
  useCancelAutomation,
  useAutomationSessions,
} from './use-agent-automations'

export type { WebhookTrigger }

const TYPE = 'webhook-triggers' as const

export function useWebhookTriggers(agentSlug: string | null, status?: 'active' | 'cancelled') {
  return useAutomationList<WebhookTrigger>(TYPE, agentSlug, status, { refetchInterval: 120_000 })
}

export function useWebhookTrigger(triggerId: string | null) {
  return useAutomationDetail<WebhookTrigger>(TYPE, triggerId, { refetchInterval: 120_000 })
}

export function useCancelWebhookTrigger() {
  return useCancelAutomation(TYPE)
}

export function useWebhookTriggerSessions(triggerId: string | null) {
  return useAutomationSessions(TYPE, triggerId)
}

export function usePauseWebhookTrigger() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ triggerId }: { triggerId: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/webhook-triggers/${triggerId}/pause`, {
        method: 'POST',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to pause webhook trigger')
      }
      return res.json() as Promise<WebhookTrigger>
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['webhook-trigger', variables.triggerId] })
      queryClient.invalidateQueries({ queryKey: ['webhook-triggers', variables.agentSlug] })
    },
  })
}

export function useResumeWebhookTrigger() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ triggerId }: { triggerId: string; agentSlug: string }) => {
      const res = await apiFetch(`/api/webhook-triggers/${triggerId}/resume`, {
        method: 'POST',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to resume webhook trigger')
      }
      return res.json() as Promise<WebhookTrigger>
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['webhook-trigger', variables.triggerId] })
      queryClient.invalidateQueries({ queryKey: ['webhook-triggers', variables.agentSlug] })
    },
  })
}

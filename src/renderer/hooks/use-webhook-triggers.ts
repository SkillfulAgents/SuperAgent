/**
 * Webhook Triggers Hooks
 *
 * React Query hooks for managing webhook triggers.
 */

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

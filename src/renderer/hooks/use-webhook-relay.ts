import { apiFetch } from '@renderer/lib/api'
import { useQuery } from '@tanstack/react-query'
import type { WebhookRelayStatus } from '@shared/lib/webhook-relay/status'

export const WEBHOOK_RELAY_QUERY_KEY = ['webhook-relay'] as const

/**
 * Whether this host can receive webhooks, and how. The notification stream's
 * `webhook_relay_changed` event keeps it current.
 */
export function useWebhookRelay() {
  return useQuery<WebhookRelayStatus>({
    queryKey: WEBHOOK_RELAY_QUERY_KEY,
    queryFn: async () => {
      const res = await apiFetch('/api/webhook-relay')
      if (!res.ok) throw new Error('Failed to fetch webhook relay status')
      return res.json()
    },
  })
}

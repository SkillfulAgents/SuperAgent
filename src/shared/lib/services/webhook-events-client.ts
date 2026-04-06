/**
 * Webhook Events Client
 *
 * Calls the platform proxy's webhook event endpoints for
 * polling pending events and acknowledging consumed events.
 */

import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'

// ============================================================================
// Types
// ============================================================================

export interface WebhookEvent {
  id: string
  composio_trigger_id: string
  trigger_type: string
  payload: unknown
  created_at: string
}

export interface RealtimeConfig {
  url: string
  jwt: string
  channel: string
}

export interface PollResult {
  events: WebhookEvent[]
  realtime: RealtimeConfig | null
}

// ============================================================================
// API Calls
// ============================================================================

async function webhookEventsFetch<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getPlatformAccessToken()
  if (!token) {
    throw new Error('Platform access token not available')
  }

  const baseUrl = getPlatformProxyBaseUrl()
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(`${baseUrl}/v1/webhook-events${endpoint}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Webhook events API error ${response.status}: ${text}`)
  }

  return response.json()
}

/**
 * Poll for pending webhook events and get Realtime connection credentials.
 * Events are atomically claimed (status: pending → claimed) on the server side.
 */
export async function pollAndClaimEvents(): Promise<PollResult> {
  return webhookEventsFetch<PollResult>('/poll', { method: 'POST' })
}

/**
 * Acknowledge events as consumed so they are not returned in the next poll.
 */
export async function acknowledgeEvents(eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return
  await webhookEventsFetch('/ack', {
    method: 'POST',
    body: JSON.stringify({ event_ids: eventIds }),
  })
}

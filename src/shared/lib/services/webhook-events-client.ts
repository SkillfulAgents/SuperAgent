/**
 * Webhook Events Client
 *
 * Calls the platform proxy's webhook event endpoints for
 * polling pending events and acknowledging consumed events.
 */

import { decodeOrgIdFromToken } from '@shared/lib/platform-attribution'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getActiveComposioTriggerIds } from '@shared/lib/services/webhook-trigger-service'

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
  apikey: string
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

// Org JWTs encode the acting member as `<token>::<memberId>`; opaque keys ignore it.
function buildBearer(memberId: string): string {
  const token = getPlatformAccessToken()
  if (!token) {
    throw new Error('Platform access token not available')
  }
  return decodeOrgIdFromToken(token) ? `${token}::${memberId}` : token
}

async function webhookEventsFetch<T>(
  endpoint: string,
  memberId: string,
  options: RequestInit = {},
): Promise<T> {
  const baseUrl = getPlatformProxyBaseUrl()
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${buildBearer(memberId)}`)

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

// Always scope by local trigger_ids
export async function pollAndClaimEvents(memberId: string): Promise<PollResult> {
  return webhookEventsFetch<PollResult>('/poll', memberId, {
    method: 'POST',
    body: JSON.stringify({ trigger_ids: getActiveComposioTriggerIds() }),
  })
}

/** Mark events consumed (must use the same memberId that claimed them). */
export async function acknowledgeEvents(
  eventIds: string[],
  memberId: string,
): Promise<void> {
  if (eventIds.length === 0) return
  await webhookEventsFetch('/ack', memberId, {
    method: 'POST',
    body: JSON.stringify({ event_ids: eventIds }),
  })
}

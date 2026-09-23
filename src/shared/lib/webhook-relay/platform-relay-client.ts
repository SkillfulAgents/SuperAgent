/**
 * HTTP calls to the platform proxy's webhook relay (`/v1/webhook-events`).
 * Only PlatformWebhookRelayService calls these; features register as relay
 * consumers instead.
 */

import { captureException } from '@shared/lib/error-reporting'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { decodeOrgIdFromToken } from '@shared/lib/platform-auth/decode-org-id'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import type { RealtimeConfig } from '@shared/lib/services/supabase-realtime-client'
import { platformClaimResponseSchema, platformRelayEventSchema } from './platform-relay-schema'
import type { RelayEvent, RelayScope } from './types'

export class PlatformRelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'PlatformRelayError'
  }
}

export interface PlatformClaim {
  events: RelayEvent[]
  /** Rows the platform claimed, including any that failed validation. */
  claimed: number
  /** Fresh realtime credentials; the proxy mints a new JWT on every claim. */
  realtime: RealtimeConfig | null
}

// Org tokens carry the acting member as `<token>::<memberId>`; opaque keys are
// already bound to one member and pass through unchanged.
function bearerFor(scope: RelayScope): string {
  const token = getPlatformAccessToken()
  if (!token) throw new PlatformRelayError(401, 'Platform access token not available')
  return decodeOrgIdFromToken(token) ? `${token}::${scope}` : token
}

async function relayPost(path: '/poll' | '/ack', scope: RelayScope, body: unknown): Promise<Response> {
  const response = await fetch(`${getPlatformProxyBaseUrl()}/v1/webhook-events${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerFor(scope)}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new PlatformRelayError(
      response.status,
      `Webhook relay ${path} failed with ${response.status}: ${text.slice(0, 300)}`,
    )
  }
  return response
}

/** Claims pending events for these endpoints. A claim is final: unacknowledged events are not redelivered (SUP-931). */
export async function claimPlatformRelayEvents(
  scope: RelayScope,
  endpointIds: readonly string[],
): Promise<PlatformClaim> {
  const response = await relayPost('/poll', scope, { trigger_ids: endpointIds })
  const parsed = platformClaimResponseSchema.parse(await response.json())
  const events: RelayEvent[] = []
  for (const row of parsed.events) {
    const event = platformRelayEventSchema.safeParse(row)
    if (!event.success) {
      // Already claimed, so it is lost either way; never attach the row, which
      // carries a third party's request.
      captureException(event.error, {
        level: 'warning',
        tags: { area: 'webhook-relay', op: 'event-parse' },
      })
      continue
    }
    events.push({
      id: event.data.id,
      endpointId: event.data.composio_trigger_id,
      type: event.data.trigger_type,
      payload: event.data.payload,
      createdAt: event.data.created_at,
    })
  }
  return { events, claimed: parsed.events.length, realtime: parsed.realtime ?? null }
}

/** Marks events consumed. Must use the scope that claimed them. */
export async function acknowledgePlatformRelayEvents(
  scope: RelayScope,
  eventIds: readonly string[],
): Promise<void> {
  if (eventIds.length === 0) return
  const response = await relayPost('/ack', scope, { event_ids: eventIds })
  await response.text().catch(() => '')
}

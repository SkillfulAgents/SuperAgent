/**
 * Webhook Endpoints Client
 *
 * Calls the platform proxy's webhook-endpoint management routes
 * (/v1/webhook-endpoints) to mint, update, and disable the agent-minted
 * public webhook URLs served at /v1/hooks/{token}.
 */

import { captureException } from '@shared/lib/error-reporting'
import { decodeOrgIdFromToken } from '@shared/lib/platform-attribution'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import {
  webhookEndpointSchema,
  webhookEndpointListSchema,
  type VerificationProfile,
  type WebhookEndpoint,
} from './webhook-endpoint-schema'

// Org JWTs encode the acting member as `<token>::<memberId>`; opaque keys ignore it.
function buildBearer(memberId: string): string {
  const token = getPlatformAccessToken()
  if (!token) {
    throw new Error('Platform access token not available')
  }
  return decodeOrgIdFromToken(token) ? `${token}::${memberId}` : token
}

async function endpointsFetch(
  endpoint: string,
  memberId: string,
  options: RequestInit = {},
): Promise<unknown> {
  const baseUrl = getPlatformProxyBaseUrl()
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${buildBearer(memberId)}`)

  const response = await fetch(`${baseUrl}/v1/webhook-endpoints${endpoint}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    // Truncate: the proxy's error body could echo the submitted request
    // (including the HMAC secret) and this message flows into logs + the agent
    // transcript. Cap it so a full-body echo can't leak wholesale.
    throw new Error(`Webhook endpoints API error ${response.status}: ${text.slice(0, 500)}`)
  }

  return response.json()
}

/** Mint a new public webhook endpoint; returns it including the public URL. */
export async function createPlatformWebhookEndpoint(
  memberId: string,
  params: { name: string; verification?: VerificationProfile },
): Promise<WebhookEndpoint> {
  const data = await endpointsFetch('', memberId, {
    method: 'POST',
    body: JSON.stringify(params),
  })
  const parsed = webhookEndpointSchema.safeParse(data)
  if (!parsed.success) {
    // The mint succeeded server-side (a public URL is now live) but the
    // response didn't match our schema (proxy drift). We can't hand back a
    // usable endpoint, and the caller's rollback keys off a returned value, so
    // roll back here where we still hold the raw id — otherwise the URL is
    // orphaned live with no local trigger row.
    const rawId = (data as { id?: unknown })?.id
    if (typeof rawId === 'string' && rawId) {
      await disablePlatformWebhookEndpoint(memberId, rawId).catch((rollbackError) => {
        captureException(rollbackError, {
          tags: { area: 'webhook-endpoints', op: 'create-parse-rollback' },
          extra: { memberId, rawEndpointId: rawId },
        })
      })
    }
    captureException(parsed.error, {
      tags: { area: 'webhook-endpoints', op: 'create-parse-response' },
      extra: { memberId, rawEndpointId: typeof rawId === 'string' ? rawId : undefined },
    })
    throw new Error('Platform returned an unexpected webhook-endpoint response')
  }
  return parsed.data
}

export async function listPlatformWebhookEndpoints(memberId: string): Promise<WebhookEndpoint[]> {
  const data = await endpointsFetch('', memberId, { method: 'GET' })
  return webhookEndpointListSchema.parse(data).endpoints
}

export async function getPlatformWebhookEndpoint(
  memberId: string,
  endpointId: string,
): Promise<WebhookEndpoint> {
  const data = await endpointsFetch(`/${encodeURIComponent(endpointId)}`, memberId, {
    method: 'GET',
  })
  return webhookEndpointSchema.parse(data)
}

/**
 * Update name and/or verification. Load-bearing for the common flow where the
 * signing secret only becomes known AFTER registering the URL with the
 * third-party service. `verification: null` clears the profile.
 */
export async function updatePlatformWebhookEndpoint(
  memberId: string,
  endpointId: string,
  params: { name?: string; verification?: VerificationProfile | null },
): Promise<WebhookEndpoint> {
  const data = await endpointsFetch(`/${encodeURIComponent(endpointId)}`, memberId, {
    method: 'PATCH',
    body: JSON.stringify(params),
  })
  return webhookEndpointSchema.parse(data)
}

/** Disable (soft-delete): ingest starts returning 404 for the URL. */
export async function disablePlatformWebhookEndpoint(
  memberId: string,
  endpointId: string,
): Promise<void> {
  await endpointsFetch(`/${encodeURIComponent(endpointId)}`, memberId, { method: 'DELETE' })
}

/**
 * Platform Notifications Client
 *
 * Calls the platform proxy's /v1/notifications endpoints: live inbox reads,
 * Realtime credential minting, and mark-read write-through. Modeled on
 * webhook-events-client; responses are Zod-parsed at this boundary.
 */

import { decodeOrgIdFromToken } from '@shared/lib/platform-attribution'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import {
  markReadResponseSchema,
  notificationsRealtimeConfigSchema,
  platformNotificationsListSchema,
  type PlatformNotificationsList,
} from '@shared/lib/services/platform-notifications-schema'
import type { RealtimeConfig } from '@shared/lib/services/webhook-events-client'

// Org JWTs encode the acting member as `<token>::<memberId>`; opaque keys ignore it.
function buildBearer(memberId: string): string {
  const token = getPlatformAccessToken()
  if (!token) {
    throw new Error('Platform access token not available')
  }
  return decodeOrgIdFromToken(token) ? `${token}::${memberId}` : token
}

async function notificationsFetch(
  endpoint: string,
  memberId: string,
  options: RequestInit = {},
): Promise<unknown> {
  const baseUrl = getPlatformProxyBaseUrl()
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${buildBearer(memberId)}`)

  const response = await fetch(`${baseUrl}/v1/notifications${endpoint}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Platform notifications API error ${response.status}: ${text}`)
  }

  return response.json()
}

export interface ListPlatformNotificationsOptions {
  status?: 'all' | 'unread'
  limit?: number
  offset?: number
}

export async function listPlatformNotifications(
  options: ListPlatformNotificationsOptions,
  memberId: string,
): Promise<PlatformNotificationsList> {
  const params = new URLSearchParams()
  if (options.status) params.set('status', options.status)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.offset !== undefined) params.set('offset', String(options.offset))
  const query = params.size > 0 ? `?${params.toString()}` : ''

  const raw = await notificationsFetch(query, memberId)
  return platformNotificationsListSchema.parse(raw)
}

/** Mint user-scoped Realtime credentials; null when no acting user resolves. */
export async function getNotificationsRealtimeConfig(
  memberId: string,
): Promise<RealtimeConfig | null> {
  const raw = await notificationsFetch('/realtime', memberId, { method: 'POST' })
  return notificationsRealtimeConfigSchema.parse(raw).realtime
}

/** Mark notifications read (scoped platform-side to the caller's user). */
export async function markPlatformNotificationsRead(
  ids: string[],
  memberId: string,
): Promise<number> {
  if (ids.length === 0) return 0
  const raw = await notificationsFetch('/read', memberId, {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
  return markReadResponseSchema.parse(raw).updated
}

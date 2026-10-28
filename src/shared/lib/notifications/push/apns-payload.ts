import type { NotificationEvent } from '../notification-event'
import type { ApnsDeviceRow } from './apns-device-service'

/**
 * One push object in the APNs relay's wire contract (POST {relayUrl}/push).
 * The relay spreads `data` at the top level of the APNs payload (stripping any
 * `aps` key) and, for alerts, adds sound=default and thread-id=agentSlug
 * itself — so this builder only supplies content, addressing, and lifetime.
 */
export interface ApnsRelayPush {
  deviceToken: string
  environment: string
  kind: 'alert' | 'background'
  alert?: { title: string; body: string }
  data: Record<string, unknown>
  collapseId?: string
  expiration?: number
}

/**
 * How long APNs may hold an undelivered push for an offline device. Mirrors
 * WebPushChannel's TTLs: an "Action Required" prompt is pointless once the
 * review window has passed; a completion is stale after an hour.
 */
const PUSH_TTL_SECONDS: Record<string, number> = {
  session_waiting: 10 * 60,
  session_complete: 60 * 60,
}
const DEFAULT_PUSH_TTL_SECONDS = 60 * 60

function expirationFor(type: string, nowMs: number): number {
  return Math.floor(nowMs / 1000) + (PUSH_TTL_SECONDS[type] ?? DEFAULT_PUSH_TTL_SECONDS)
}

/**
 * APNs collapse id (≤64 chars, header-safe): one id per session, so while the
 * device is offline a newer push for the same session replaces an undelivered
 * older one (a stale "Action Required") instead of stacking behind it.
 */
function collapseIdForSession(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
}

/**
 * Visible alert push — only for the device that started the session (origin).
 * `data` keys land at the top level of the APNs payload for the app's
 * notification tap handler; `workspaceId` echoes the device's registration
 * workspaceTag so the app can route to the right paired deployment.
 */
export function buildApnsAlertPush(
  event: NotificationEvent,
  device: ApnsDeviceRow,
  nowMs: number = Date.now()
): ApnsRelayPush {
  return {
    deviceToken: device.token,
    environment: device.environment,
    kind: 'alert',
    alert: { title: event.title, body: event.body },
    data: {
      type: event.type,
      notificationId: event.notificationId,
      sessionId: event.sessionId,
      agentSlug: event.agentSlug,
      navigatePath: event.navigatePath,
      workspaceId: device.workspaceTag ?? undefined,
    },
    collapseId: collapseIdForSession(event.sessionId),
    expiration: expirationFor(event.type, nowMs),
  }
}

/**
 * Silent content-available push — widget/snapshot invalidation for every
 * registered device that is not the session's origin. No alert content and no
 * collapse id (background pushes don't stack in Notification Center).
 */
export function buildApnsBackgroundPush(
  event: NotificationEvent,
  device: ApnsDeviceRow,
  nowMs: number = Date.now()
): ApnsRelayPush {
  return {
    deviceToken: device.token,
    environment: device.environment,
    kind: 'background',
    data: {
      type: event.type,
      sessionId: event.sessionId,
      agentSlug: event.agentSlug,
      workspaceId: device.workspaceTag ?? undefined,
    },
    expiration: expirationFor(event.type, nowMs),
  }
}

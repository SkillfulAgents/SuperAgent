import { isAuthMode } from '@shared/lib/auth/mode'
import { getApnsRelayConfig } from '@shared/lib/config/settings'
import { getUserSettings } from '@shared/lib/services/user-settings-service'
import { getAccessibleAgentSlugs } from '@shared/lib/services/notification-service'
import { getSessionMetadata } from '@shared/lib/services/session-service'
import {
  listDeliverableApnsDevices,
  deleteApnsDeviceById,
  type ApnsDeviceRow,
} from '../push/apns-device-service'
import {
  buildApnsAlertPush,
  buildApnsBackgroundPush,
  type ApnsRelayPush,
} from '../push/apns-payload'
import { isNotificationTypeEnabled } from '../notification-preferences'
import type { NotificationType } from '@shared/lib/services/notification-service'
import type { NotificationChannel } from './types'
import type { NotificationEvent } from '../notification-event'

/**
 * Only the "phone me" types may show a visible alert — and only on the device
 * that started the session. Everything else the channel carries is a silent
 * content-available push (widget/snapshot invalidation), so the silent set is
 * wider: automation runs change agent state the widget shows, but must never
 * buzz a phone.
 * Typed against the union so a renamed or mistyped member fails typecheck
 * instead of silently never pushing.
 */
const VISIBLE_TYPES = new Set<NotificationType>(['session_complete', 'session_waiting'])
const SILENT_TYPES = new Set<NotificationType>([
  'session_complete',
  'session_waiting',
  'session_scheduled',
  'session_webhook',
])

/** Relay wire contract: 1..50 pushes per request. */
const MAX_PUSHES_PER_REQUEST = 50
const SEND_TIMEOUT_MS = 10_000

/**
 * Relay result statuses/reasons that mean the token is permanently dead
 * (uninstalled app, rotated token, token from a different app/topic) — the
 * device row is pruned. Everything else (RelayRateLimited 429, RelayFetchFailed
 * status 0, 5xx) is transient: log and keep the row.
 */
function isTokenDead(status: number, reason: string | undefined): boolean {
  return (
    status === 410 ||
    reason === 'Unregistered' ||
    reason === 'BadDeviceToken' ||
    reason === 'DeviceTokenNotForTopic'
  )
}

interface RelayResult {
  deviceToken: string
  status: number
  reason?: string
}

/**
 * Delivers over APNs (via the deployed Cloudflare Worker relay, which holds
 * the APNs credentials) to native iOS app installs with a registered device
 * token. Like WebPushChannel there is no live client to defer policy to, so
 * gating happens here per device: the type allowlists, the owner's
 * notification settings, and (in auth mode) the owner's agent access.
 *
 * Alert routing: only the device whose mobile-device family started the
 * session (session metadata `createdByDeviceId`) gets a visible alert; every
 * other eligible device gets a silent background push. Sessions with no origin
 * (web/cron/webhook) are silent to everyone. An origin device whose owner
 * disabled the type degrades to a background push — never to nothing, so the
 * widget still refreshes.
 */
export class ApnsRelayChannel implements NotificationChannel {
  readonly id = 'apns_relay'

  async deliver(event: NotificationEvent): Promise<void> {
    try {
      await this.deliverInner(event)
    } catch (error) {
      // Fire-and-forget: a relay/config failure must never affect other channels.
      console.error('[ApnsRelayChannel] delivery failed:', error)
    }
  }

  private async deliverInner(event: NotificationEvent): Promise<void> {
    if (!SILENT_TYPES.has(event.type)) {
      return
    }

    const { url } = getApnsRelayConfig()
    if (!url) {
      return
    }

    const devices = listDeliverableApnsDevices()
    if (devices.length === 0) {
      return
    }

    const originDeviceId = await this.getOriginDeviceId(event)

    // Several devices can share an owner — resolve agent access once per user.
    const accessCache = new Map<string, Promise<string[]>>()

    const batch: Array<{ device: ApnsDeviceRow; push: ApnsRelayPush }> = []
    for (const device of devices) {
      const push = await this.buildPushForDevice(event, device, originDeviceId, accessCache)
      if (push) {
        batch.push({ device, push })
      }
    }
    if (batch.length === 0) {
      return
    }

    for (let i = 0; i < batch.length; i += MAX_PUSHES_PER_REQUEST) {
      await this.sendChunk(url, batch.slice(i, i + MAX_PUSHES_PER_REQUEST))
    }
  }

  /**
   * Which mobile-device family gets the VISIBLE push for this session.
   * "Last speaker claims the alert": alertDeviceId is re-stamped on every
   * device-authenticated message send and explicitly null when a deviceless
   * surface (web) spoke last; absent means the session was never re-claimed,
   * so the creation stamp decides. Null result = silent for everyone.
   */
  private async getOriginDeviceId(event: NotificationEvent): Promise<string | null> {
    try {
      const meta = await getSessionMetadata(event.agentSlug, event.sessionId)
      if (!meta) return null
      if (meta.alertDeviceId !== undefined) return meta.alertDeviceId
      return meta.createdByDeviceId ?? null
    } catch (error) {
      console.error('[ApnsRelayChannel] failed to read session metadata:', error)
      return null
    }
  }

  /** Per-device gating + payload choice; null = skip this device entirely. */
  private async buildPushForDevice(
    event: NotificationEvent,
    device: ApnsDeviceRow,
    originDeviceId: string | null,
    accessCache: Map<string, Promise<string[]>>
  ): Promise<ApnsRelayPush | null> {
    if (isAuthMode()) {
      // An ownerless row in auth mode (e.g. registered before auth was
      // enabled) has no user to gate on — never deliver to it.
      if (!device.userId) {
        return null
      }
      let access = accessCache.get(device.userId)
      if (!access) {
        access = getAccessibleAgentSlugs(device.userId)
        accessCache.set(device.userId, access)
      }
      // No access to the agent means no push at all — a silent push still
      // leaks that the agent ran.
      if (!(await access).includes(event.agentSlug)) {
        return null
      }
    }

    const isOrigin = device.mobileDeviceId != null && device.mobileDeviceId === originDeviceId
    if (isOrigin && VISIBLE_TYPES.has(event.type)) {
      // In local mode the single local user's settings govern every device —
      // including rows that retain a userId from a previous auth-mode life of
      // this database (that user's old per-user settings row is stale there).
      const ownerId = isAuthMode() ? (device.userId as string) : 'local'
      const settings = getUserSettings(ownerId)
      if (isNotificationTypeEnabled(settings.notifications, event.type)) {
        return buildApnsAlertPush(event, device)
      }
      // Prefs disabled: degrade to background so the widget still refreshes.
    }
    return buildApnsBackgroundPush(event, device)
  }

  private async sendChunk(
    url: string,
    chunk: Array<{ device: ApnsDeviceRow; push: ApnsRelayPush }>
  ): Promise<void> {
    let results: RelayResult[]
    try {
      const response = await fetch(`${url}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pushes: chunk.map((entry) => entry.push) }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      if (!response.ok) {
        console.error(`[ApnsRelayChannel] relay returned HTTP ${response.status}; keeping devices`)
        return
      }
      const body = (await response.json()) as { results?: RelayResult[] }
      if (!Array.isArray(body.results)) {
        console.error('[ApnsRelayChannel] relay response missing results array')
        return
      }
      results = body.results
    } catch (error) {
      // Network failure/timeout is transient — never prune on it.
      console.error('[ApnsRelayChannel] relay request failed:', error)
      return
    }

    // Results come back in input order, one per push.
    results.forEach((result, index) => {
      const entry = chunk[index]
      if (!entry) {
        return
      }
      if (isTokenDead(result.status, result.reason)) {
        deleteApnsDeviceById(entry.device.id)
        return
      }
      if (result.status < 200 || result.status >= 300) {
        // Transient (RelayRateLimited 429, RelayFetchFailed 0, 5xx): log, keep.
        console.error(
          `[ApnsRelayChannel] push failed (${result.status}${result.reason ? ` ${result.reason}` : ''}) for device ${entry.device.id}`
        )
      }
    })
  }
}

import webPush from 'web-push'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getUserSettings } from '@shared/lib/services/user-settings-service'
import { getAccessibleAgentSlugs } from '@shared/lib/services/notification-service'
import {
  listPushSubscriptions,
  deletePushSubscriptionById,
  type PushSubscriptionRow,
} from '../push/push-subscription-service'
import { getVapidKeys, type VapidKeyPair } from '../push/vapid-keys'
import { buildDeclarativePushPayload } from '../push/push-payload'
import { isNotificationTypeEnabled } from '../notification-preferences'
import type { NotificationType } from '@shared/lib/services/notification-service'
import type { NotificationChannel } from './types'
import type { NotificationEvent } from '../notification-event'

/**
 * Only the "phone me" types go out over push. Scheduled/webhook/chat
 * integration chatter stays on the client-broadcast channel — a phone buzz
 * for every automated run would be spam.
 * Typed against the union so a renamed or mistyped member fails typecheck
 * instead of silently never pushing.
 */
const PUSHABLE_TYPES = new Set<NotificationType>(['session_complete', 'session_waiting'])

/**
 * How long the push service may hold an undelivered push for an offline
 * device (web-push's default is FOUR WEEKS). An "Action Required" prompt is
 * pointless once the review window has passed; a completion is stale after an
 * hour — better dropped than delivered days later.
 */
const PUSH_TTL_SECONDS: Record<string, number> = {
  session_waiting: 10 * 60,
  session_complete: 60 * 60,
}
const DEFAULT_PUSH_TTL_SECONDS = 60 * 60

/** Per-notification outbound bounds: batch size and per-request socket timeout. */
const SEND_CONCURRENCY = 8
const SEND_TIMEOUT_MS = 10_000

/**
 * Push-service coalescing topic (RFC 8030 §5.4, ≤32 base64url chars): one
 * topic per session, so while the device is offline a newer push for the same
 * session (e.g. session_complete) replaces an undelivered older one (a stale
 * "Action Required") instead of queueing behind it.
 */
function topicForSession(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
}

/**
 * VAPID `sub` must be a mailto: or https: URL identifying the sender. The
 * subscription's own origin is both — except in dev, where a localhost origin
 * can be plain http; fall back to the project URL there.
 */
function vapidSubjectForOrigin(origin: string): string {
  return origin.startsWith('https:')
    ? origin
    : 'https://github.com/SkillfulAgents/SuperAgent'
}

/**
 * Delivers over Web Push to devices with a stored subscription — the channel
 * that reaches a phone whose PWA (and browser) is closed. There is no live
 * client to defer policy to, so gating happens here, per subscription:
 * the pushable-type allowlist, the owner's notification settings, and (in
 * auth mode) the owner's agent access.
 */
export class WebPushChannel implements NotificationChannel {
  readonly id = 'web_push'

  async deliver(event: NotificationEvent): Promise<void> {
    if (!PUSHABLE_TYPES.has(event.type)) {
      return
    }

    const subscriptions = listPushSubscriptions()
    if (subscriptions.length === 0) {
      return
    }

    const vapidKeys = getVapidKeys()
    if (!vapidKeys) {
      // Rows exist but the keypair they were minted against is gone — every
      // send would 403. getOrCreateVapidKeys clears them on next subscribe.
      console.error(
        '[WebPushChannel] push subscriptions exist but VAPID keys are missing; skipping send'
      )
      return
    }

    // Several subscriptions can share an owner — resolve agent access once per user.
    const accessCache = new Map<string, Promise<string[]>>()

    // Bounded fan-out: batches of SEND_CONCURRENCY rather than one socket per
    // stored subscription at once.
    for (let i = 0; i < subscriptions.length; i += SEND_CONCURRENCY) {
      await Promise.allSettled(
        subscriptions
          .slice(i, i + SEND_CONCURRENCY)
          .map((subscription) =>
            this.sendToSubscription(event, subscription, vapidKeys, accessCache)
          )
      )
    }
  }

  private async sendToSubscription(
    event: NotificationEvent,
    subscription: PushSubscriptionRow,
    vapidKeys: VapidKeyPair,
    accessCache: Map<string, Promise<string[]>>
  ): Promise<void> {
    if (isAuthMode()) {
      // An ownerless row in auth mode (e.g. subscribed before auth was
      // enabled) has no user to gate on — never deliver to it.
      if (!subscription.userId) {
        return
      }
      let access = accessCache.get(subscription.userId)
      if (!access) {
        access = getAccessibleAgentSlugs(subscription.userId)
        accessCache.set(subscription.userId, access)
      }
      if (!(await access).includes(event.agentSlug)) {
        return
      }
    }

    // In local mode the single local user's settings govern every device —
    // including rows that retain a userId from a previous auth-mode life of
    // this database (that user's old per-user settings row is stale there).
    const ownerId = isAuthMode() ? (subscription.userId as string) : 'local'
    const settings = getUserSettings(ownerId)
    if (!isNotificationTypeEnabled(settings.notifications, event.type)) {
      return
    }

    const payload = buildDeclarativePushPayload(event, subscription.origin)
    try {
      await webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.keysP256dh, auth: subscription.keysAuth },
        },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: vapidSubjectForOrigin(subscription.origin),
            publicKey: vapidKeys.publicKey,
            privateKey: vapidKeys.privateKey,
          },
          urgency: 'high',
          TTL: PUSH_TTL_SECONDS[event.type] ?? DEFAULT_PUSH_TTL_SECONDS,
          topic: topicForSession(event.sessionId),
          timeout: SEND_TIMEOUT_MS,
        }
      )
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode
      // 404/410 = the push service says this subscription no longer exists.
      // 401/403 = the service rejects our VAPID identity for it — the row was
      // minted against a keypair we no longer hold (restored DB, wiped keys),
      // so it is permanently undeliverable by us. Our keys never rotate in
      // normal operation, making auth failures safe to treat as fatal.
      // Pruning here is the whole expiry story: no service worker means no
      // pushsubscriptionchange event to tell us otherwise.
      if (statusCode === 401 || statusCode === 403 || statusCode === 404 || statusCode === 410) {
        deletePushSubscriptionById(subscription.id)
        return
      }
      console.error(
        `[WebPushChannel] send failed (${statusCode ?? 'no status'}) for subscription ${subscription.id}:`,
        error
      )
    }
  }
}

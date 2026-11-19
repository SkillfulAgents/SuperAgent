import webPush from 'web-push'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getUserSettings, getUserSettingsForUsers } from '@shared/lib/services/user-settings-service'
import {
  listPushSubscriptions,
  listPushSubscriptionsForAgentMembers,
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
const PUSHABLE_TYPES = new Set<NotificationType>(['session_complete', 'session_waiting', 'session_mention'])

/**
 * How long the push service may hold an undelivered push for an offline
 * device (web-push's default is FOUR WEEKS). An "Action Required" prompt is
 * pointless once the review window has passed; a completion is stale after an
 * hour — better dropped than delivered days later.
 */
const PUSH_TTL_SECONDS: Record<string, number> = {
  session_waiting: 10 * 60,
  session_complete: 60 * 60,
  session_mention: 24 * 60 * 60,
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
    : 'https://www.gamut.so'
}

/**
 * Delivers over Web Push to devices with a stored subscription — the channel
 * that reaches a phone whose PWA (and browser) is closed. There is no live
 * client to defer policy to, so gating happens here, per subscription:
 * the pushable-type allowlist, (in auth mode) the owner's agent access, and
 * the owner's notification settings.
 */
export class WebPushChannel implements NotificationChannel {
  readonly id = 'web_push'

  async deliver(event: NotificationEvent): Promise<void> {
    if (!PUSHABLE_TYPES.has(event.type)) {
      return
    }

    // The statements below are a fixed number however many people and devices
    // the deployment has: every finished or blocked turn comes through here.
    const authMode = isAuthMode()
    // With sign-in the access gate is part of the read: only subscriptions of
    // people who have joined and are on the agent's access list come back
    // (never an ownerless row, e.g. one subscribed before auth was enabled),
    // and for a mention only those of the person tagged.
    const subscriptions = authMode
      ? await listPushSubscriptionsForAgentMembers(event.agentSlug, event.recipientUserId)
      : await listPushSubscriptions()
    if (subscriptions.length === 0) {
      return
    }

    const vapidKeys = await getVapidKeys()
    if (!vapidKeys) {
      // Rows exist but the keypair they were minted against is gone — every
      // send would 403. getOrCreateVapidKeys clears them on next subscribe.
      console.error(
        '[WebPushChannel] push subscriptions exist but VAPID keys are missing; skipping send'
      )
      return
    }

    // In local mode the single local user's settings govern every device —
    // including rows that retain a userId from a previous auth-mode life of
    // this database (that user's old per-user settings row is stale there).
    // Several subscriptions can share an owner: each owner is read once, and
    // all of them together.
    const ownerOf = (subscription: PushSubscriptionRow): string =>
      authMode ? (subscription.userId as string) : 'local'
    const settingsByOwner = authMode
      ? await getUserSettingsForUsers(subscriptions.map(ownerOf))
      : new Map([['local', await getUserSettings('local')]])
    const wanted = subscriptions.filter((subscription) => {
      const settings = settingsByOwner.get(ownerOf(subscription))
      return settings !== undefined && isNotificationTypeEnabled(settings.notifications, event.type)
    })

    // Bounded fan-out: batches of SEND_CONCURRENCY rather than one socket per
    // subscription at once.
    for (let i = 0; i < wanted.length; i += SEND_CONCURRENCY) {
      await Promise.allSettled(
        wanted
          .slice(i, i + SEND_CONCURRENCY)
          .map((subscription) => this.sendToSubscription(event, subscription, vapidKeys))
      )
    }
  }

  private async sendToSubscription(
    event: NotificationEvent,
    subscription: PushSubscriptionRow,
    vapidKeys: VapidKeyPair
  ): Promise<void> {
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
        await deletePushSubscriptionById(subscription.id)
        return
      }
      console.error(
        `[WebPushChannel] send failed (${statusCode ?? 'no status'}) for subscription ${subscription.id}:`,
        error
      )
    }
  }
}

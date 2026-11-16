import { globalFeed } from '@shared/lib/notifications/global-feed'
import type { NotificationChannel } from './types'
import type { NotificationEvent } from '../notification-event'

/**
 * Delivers to currently-connected clients over the global SSE stream as an
 * `os_notification` frame. Display policy stays client-side: the renderer
 * decides whether to pop an OS notification (tab visibility, window focus,
 * per-user settings in auth mode, viewed-session suppression), and the SSE
 * route applies per-user agent-access filtering in auth mode.
 */
export class ClientBroadcastChannel implements NotificationChannel {
  readonly id = 'client_broadcast'

  async deliver(event: NotificationEvent): Promise<void> {
    globalFeed.publish({
      type: 'os_notification',
      notificationId: event.notificationId,
      notificationType: event.type,
      sessionId: event.sessionId,
      agentSlug: event.agentSlug,
      title: event.title,
      body: event.body,
      ...(event.actions ? { actions: event.actions } : {}),
      ...(event.actionContext ? { actionContext: event.actionContext } : {}),
      // The SSE route sends a targeted frame to its recipient only.
      ...(event.recipientUserId ? { recipientUserId: event.recipientUserId } : {}),
      ...(event.messageUuid ? { messageUuid: event.messageUuid } : {}),
      ...event.extra,
    })
  }
}

/** Tells a recipient's clients that a mention was taken back, so its @ goes. The SSE route sends it to them alone. */
export function broadcastMentionWithdrawn(row: { recipientUserId: string; agentSlug: string; sessionId: string }): void {
  globalFeed.publish({ type: 'session_mention_withdrawn', ...row })
}

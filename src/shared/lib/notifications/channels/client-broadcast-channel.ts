import { messagePersister } from '@shared/lib/container/message-persister'
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
    messagePersister.broadcastGlobal({
      type: 'os_notification',
      notificationId: event.notificationId,
      notificationType: event.type,
      sessionId: event.sessionId,
      agentSlug: event.agentSlug,
      title: event.title,
      body: event.body,
      ...(event.actions ? { actions: event.actions } : {}),
      ...(event.actionContext ? { actionContext: event.actionContext } : {}),
      ...event.extra,
    })
  }
}

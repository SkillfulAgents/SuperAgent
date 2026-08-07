import type { NotificationType } from '@shared/lib/services/notification-service'

/**
 * The canonical, delivery-agnostic notification payload.
 *
 * Built exactly once per trigger in NotificationManager (after the DB record
 * exists, so `notificationId` is always set) and handed to every registered
 * NotificationChannel. Channels own their own wire format — SSE frame,
 * declarative Web Push JSON, etc. — but all render from this one object, so
 * adding a delivery platform never touches the trigger sites.
 */
export interface NotificationEvent {
  notificationId: string
  type: NotificationType
  sessionId: string
  agentSlug: string
  title: string
  body: string
  /**
   * Origin-relative click-through target (e.g. `/agents/x/sessions/y`).
   * Channels that need an absolute URL (Web Push `navigate`) resolve it
   * against the address the receiving device actually uses.
   */
  navigatePath: string
  /** Action buttons, where the channel's surface supports them. */
  actions?: Array<{ text: string }>
  /** Opaque metadata round-tripped to the click/action dispatcher. */
  actionContext?: Record<string, unknown>
  /** Type-specific extras carried on the client broadcast (taskId, triggerId, …). */
  extra?: Record<string, unknown>
}

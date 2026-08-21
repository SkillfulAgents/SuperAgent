import type { UserSettingsData } from '@shared/lib/services/user-settings-service'

/**
 * Per-type notification preference check — the single source of truth for
 * mapping a notification type to its settings toggle. Used by every gate:
 * NotificationManager (non-auth mode, before the DB record is created),
 * per-user delivery channels (WebPushChannel gates on the subscription
 * owner's settings), and the renderer's client-broadcast display gate (which
 * layers focus/visibility state on top).
 *
 * `type` is a plain string, not the NotificationType union: the renderer also
 * gates wire-only types (`platform_notification`) that never hit the local
 * notifications table. Unknown types default to enabled.
 */
export function isNotificationTypeEnabled(
  notifications: UserSettingsData['notifications'],
  type: string
): boolean {
  if (!notifications.enabled) {
    return false
  }

  switch (type) {
    case 'session_complete':
      return notifications.sessionComplete !== false
    case 'session_waiting':
      return notifications.sessionWaiting !== false
    case 'session_scheduled':
      return notifications.sessionScheduled !== false
    case 'platform_notification':
      return notifications.platformNotification !== false
    default:
      return true
  }
}

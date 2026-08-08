import { ClientBroadcastChannel } from './client-broadcast-channel'
import { WebPushChannel } from './web-push-channel'
import type { NotificationChannel } from './types'

let channels: NotificationChannel[] | null = null

/**
 * Every registered delivery backend. Adding a platform (APNs for the native
 * companion app, a platform relay, …) means implementing NotificationChannel
 * and appending it here — trigger sites and the event shape don't change.
 */
export function getNotificationChannels(): NotificationChannel[] {
  if (!channels) {
    channels = [new ClientBroadcastChannel(), new WebPushChannel()]
  }
  return channels
}

import type { NotificationEvent } from '../notification-event'

/**
 * A delivery backend for notifications.
 *
 * Channels fall into two families with the same contract:
 *  - live-client channels deliver to currently-connected clients and defer
 *    display policy to them (ClientBroadcastChannel → SSE → renderer);
 *  - device-endpoint channels deliver to stored addresses with no client
 *    running, so they enforce their own policy server-side (WebPushChannel;
 *    later e.g. APNs for the native companion app, or a platform relay).
 *
 * `deliver` receives every event that passed the manager's global gates.
 * Anything channel-specific — which types it carries, per-recipient settings,
 * recipient access checks — lives inside the channel. Implementations must
 * swallow per-recipient failures; a thrown error is logged by the dispatcher
 * and never affects other channels.
 */
export interface NotificationChannel {
  readonly id: string
  deliver(event: NotificationEvent): Promise<void>
}

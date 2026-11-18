import { globalFeed } from '../notifications/global-feed'
import { LLM_CONNECTIONS_CHANGED_EVENT } from './connection-events'

/**
 * Tell the windows that list this connection that the server changed it (see
 * `LLM_CONNECTIONS_CHANGED_EVENT`). A shared connection is listed for everyone,
 * a personal one for its owner. The event says no more than that: a window
 * reads the lists again.
 */
export function announceConnectionChange(connection: { userId: string | null }): void {
  globalFeed.publish({
    type: LLM_CONNECTIONS_CHANGED_EVENT,
    ...(connection.userId ? { recipientUserId: connection.userId } : {}),
  })
}

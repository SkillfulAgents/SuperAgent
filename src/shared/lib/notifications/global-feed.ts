/**
 * The global feed: app-wide events for every connected client (session and
 * agent status for the sidebar, notifications, schedule and widget changes)
 * and for the in-process listeners that react to them (the notifications
 * stream route, chat integrations, widget refresh).
 *
 * The host owns it; it holds no per-session state. Publishing is synchronous
 * and in order: every listener has the event before `publish` returns, and a
 * listener that throws reaches neither the publisher nor the other listeners.
 *
 * An event about one agent names it at the top level (`agentSlug`). In auth
 * mode the notifications stream admits events by exactly that field, and
 * forwards an event without one to every authenticated user, so an agent's
 * slug must never be nested inside another field. An event for one person (a
 * mention) names them the same way (`recipientUserId`), and the stream
 * forwards it to them alone.
 */
export interface GlobalFeedEvent {
  type: string
  agentSlug?: string
  recipientUserId?: string
  [key: string]: unknown
}

export type GlobalFeedListener = (event: GlobalFeedEvent) => void

/**
 * Carries feed events from publishers to listeners. The feed's own listener
 * set is the default; a deployment whose publishers and open streams run in
 * different processes sets one that reaches all of them.
 */
export interface FeedTransport {
  publish(event: GlobalFeedEvent): void
  /** Returns the unsubscribe function. */
  subscribe(listener: GlobalFeedListener): () => void
}

export class GlobalFeed implements FeedTransport {
  /** Listeners that subscribed on this process's own set, each with its unsubscribe from the transport once one is set. */
  private readonly listeners = new Map<GlobalFeedListener, (() => void) | null>()
  private transport: FeedTransport | null = null

  /** A listener that subscribed earlier (a service armed when its module loads) moves onto the transport. */
  setTransport(transport: FeedTransport): void {
    this.transport = transport
    for (const [listener, leave] of this.listeners) {
      leave?.()
      this.listeners.set(listener, transport.subscribe(listener))
    }
  }

  publish(event: GlobalFeedEvent): void {
    if (this.transport) return this.transport.publish(event)
    for (const listener of this.listeners.keys()) {
      try {
        listener(event)
      } catch (error) {
        console.error('[GlobalFeed] Listener failed:', error)
      }
    }
  }

  /** Returns the unsubscribe function. */
  subscribe(listener: GlobalFeedListener): () => void {
    if (this.transport) return this.transport.subscribe(listener)
    this.listeners.set(listener, null)
    return () => {
      this.listeners.get(listener)?.()
      this.listeners.delete(listener)
    }
  }
}

// Pinned on globalThis so a dev-server module reload keeps the subscribers
// that open streams and long-lived services registered on the old module.
const globalForFeed = globalThis as unknown as { globalFeed: GlobalFeed | undefined }

export const globalFeed = globalForFeed.globalFeed ?? new GlobalFeed()

if (process.env.NODE_ENV !== 'production') {
  globalForFeed.globalFeed = globalFeed
}

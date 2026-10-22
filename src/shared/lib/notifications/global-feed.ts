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

export class GlobalFeed {
  private readonly listeners = new Set<GlobalFeedListener>()

  publish(event: GlobalFeedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[GlobalFeed] Listener failed:', error)
      }
    }
  }

  /** Returns the unsubscribe function. */
  subscribe(listener: GlobalFeedListener): () => void {
    this.listeners.add(listener)
    return () => {
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

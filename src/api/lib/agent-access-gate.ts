import { background } from '@shared/lib/background'
import type { GlobalFeedEvent } from '@shared/lib/notifications/global-feed'

/**
 * One auth-mode stream's view of the global feed: it carries an event about
 * an agent only when the user can access that agent, and it keeps the feed's
 * order.
 *
 * The user's accessible agents are loaded when the gate is created (the
 * stream opens), again whenever they may have changed (`refresh`), and on a
 * fixed period, so a membership change whose notice never reached this stream
 * is picked up within it. Between loads the check is a set lookup, so `push`
 * delivers synchronously. While a load is in flight, events wait in arrival
 * order and are judged against its result: none is dropped for an agent the
 * load is about to admit, and none overtakes another.
 *
 * An event that names no agent is delivered to everyone, as before.
 */
export interface AgentAccessGate {
  /** Offer one feed event: delivered now, held for a load in flight, or dropped. */
  push(event: GlobalFeedEvent): void
  /** The user's access may have changed: load it again before judging more events. */
  refresh(): void
  /** The stream is gone: deliver nothing more, stop re-checking, and let a load in flight land nowhere. */
  dispose(): void
}

/** How often the gate loads the user's agents again with no refresh asked for. */
export const ACCESS_RECHECK_MS = 60_000

export function createAgentAccessGate(options: {
  /** The slugs of the agents the user can access, read fresh. */
  load: () => Promise<Iterable<string>>
  deliver: (event: GlobalFeedEvent) => void
  /**
   * A load failed. The gate then holds every event about an agent, because it
   * cannot tell which ones the user may see; the caller ends the stream so
   * the client reconnects with a fresh load.
   */
  onLoadError: (error: unknown) => void
  /** The re-check period; `ACCESS_RECHECK_MS` unless a test sets it. */
  recheckEveryMs?: number
}): AgentAccessGate {
  let accessible: ReadonlySet<string> = new Set()
  let failed = false
  let loading = false
  let reloadRequested = false
  let disposed = false
  let held: GlobalFeedEvent[] = []

  const forward = (event: GlobalFeedEvent): void => {
    const slug = event.agentSlug
    if (slug && (failed || !accessible.has(slug))) return
    // A failed write is the stream's to handle; it must not cost the events
    // after it, nor escape from the load that released them.
    try {
      options.deliver(event)
    } catch (error) {
      console.error('[AgentAccessGate] Failed to deliver an event:', error)
    }
  }

  const load = async (): Promise<void> => {
    loading = true
    try {
      // A change that lands while a load is reading may not be in what it
      // read, so a refresh asked for meanwhile loads again before releasing.
      do {
        reloadRequested = false
        accessible = new Set(await options.load())
        failed = false
      } while (reloadRequested && !disposed)
    } catch (error) {
      failed = true
      if (!disposed) options.onLoadError(error)
    } finally {
      loading = false
    }
    if (disposed) return
    const waiting = held
    held = []
    for (const event of waiting) forward(event)
  }

  const refresh = (): void => {
    if (disposed) return
    if (loading) {
      reloadRequested = true
      return
    }
    background(load(), { name: 'agent-access-gate.load-accessible-agents' })
  }

  // The first load starts with the gate: an event pushed before it lands waits for it.
  background(load(), { name: 'agent-access-gate.load-accessible-agents' })
  const recheck = setInterval(refresh, options.recheckEveryMs ?? ACCESS_RECHECK_MS)
  recheck.unref?.()

  return {
    push(event) {
      if (disposed) return
      // The new agent's owners were granted access before this was
      // published, so it and everything after it waits for a fresh load.
      if (event.type === 'agent_created') refresh()
      if (loading) {
        held.push(event)
        return
      }
      forward(event)
    },
    refresh,
    dispose() {
      disposed = true
      held = []
      clearInterval(recheck)
    },
  }
}

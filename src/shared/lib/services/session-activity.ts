import type { SessionActivityMark } from '@shared/lib/agent-actor/session-index'
import type { SessionStore } from '@shared/lib/agent-actor/session-store'

export type { SessionActivityMark } from '@shared/lib/agent-actor/session-index'

function epochMs(activityAt: Date | number): number {
  return activityAt instanceof Date ? activityAt.getTime() : activityAt
}

/**
 * A write reached a session's transcript: its index entry moves to the
 * write's time. This is how a session's last activity is kept (a transcript
 * is statted once, when the index first sees it), so every transcript write
 * the host knows of is recorded here: a message sent, a frame received, an
 * append or a rewrite.
 *
 * The store's owner hears of the write too (`store.onActivity`): this is the
 * one funnel every session write passes, so it is where the agent's idle
 * clock is kept current.
 */
export function recordSessionActivity(
  store: SessionStore,
  sessionId: string,
  activityAt: Date | number = Date.now(),
): void {
  const activityAtMs = epochMs(activityAt)
  if (!Number.isFinite(activityAtMs)) return
  store.onActivity?.(activityAtMs)
  store.index.recordActivity(sessionId, activityAtMs)
}

/**
 * Record a write that may still be rolled back: an optimistic send that has
 * not reached the container yet. Returns the mark to hand back to
 * {@link revertSessionActivity} if the send fails.
 */
export function recordProvisionalSessionActivity(
  store: SessionStore,
  sessionId: string,
  activityAt: Date | number = Date.now(),
): SessionActivityMark {
  const activityAtMs = epochMs(activityAt)
  store.onActivity?.(activityAtMs)
  return store.index.recordProvisionalActivity(sessionId, activityAtMs)
}

/**
 * Undo a provisional record whose send never happened. A no-op if anything
 * was recorded since, so a late rollback can never erase real activity.
 */
export function revertSessionActivity(store: SessionStore, sessionId: string, mark: SessionActivityMark): void {
  store.index.revertProvisionalActivity(sessionId, mark)
}

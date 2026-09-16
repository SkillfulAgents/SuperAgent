import type { SessionStore } from '@shared/lib/agent-actor/session-store'
import type { SessionActivityEntry, SessionSummaryCacheSlot } from './session-summary-slot'

export type {
  SessionActivityEntry,
  SessionSummaryCache,
  SessionSummaryCacheSlot,
  SessionSummaryCacheValue,
} from './session-summary-slot'

export const SESSION_SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * The store's summary slot: the store holds it (see `SessionSummaryCache`),
 * bound to its storage identity, so two stores over different storage never
 * share one and a store whose storage moved starts fresh.
 */
export function getSessionSummaryCacheSlot(store: SessionStore): SessionSummaryCacheSlot {
  return store.summaryCache.slotFor(store.key)
}

/** Force the next summary read to reconcile the session set from the transcripts directory. */
export function invalidateSessionSummaryCache(store: SessionStore): void {
  const slot = store.summaryCache.peek(store.key)
  if (!slot) return
  slot.revision++
  slot.value = undefined
}

/**
 * Advance a per-agent summary from an authoritative transcript write.
 * This never creates a session in the summary: structural additions are
 * reconciled from the directory, preserving the ownership/filesystem gates.
 *
 * The write is applied to the cached value if there is one AND parked in the
 * slot's pending map regardless, because the cached value may be about to be
 * replaced: a cold slot, an expired one, or a build already in flight all
 * rebuild from real stats, and the transcript may not carry the write yet
 * (a send is recorded before the CLI appends the user entry). Every rebuild
 * folds pending in and clears it, so nothing is lost and nothing accumulates
 * beyond one entry per session.
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
  const activityAtMs = activityAt instanceof Date ? activityAt.getTime() : activityAt
  if (!Number.isFinite(activityAtMs)) return
  store.onActivity?.(activityAtMs)
  const slot = getSessionSummaryCacheSlot(store)

  const cached = slot.value?.activityBySession.get(sessionId)
  if (cached !== undefined) {
    applyActivity(cached, activityAtMs)
  }
  const pending = slot.pending.get(sessionId)
  if (!pending?.deleted) {
    slot.pending.set(sessionId, {
      activityAtMs: Math.max(pending?.activityAtMs ?? -Infinity, activityAtMs),
    })
  }
}

/** What {@link revertSessionActivity} needs to undo one recorded write. */
export interface SessionActivityMark {
  recordedAtMs: number
  /** The cached entry as it was before the record; null if there was none. */
  previous: { mtimeMs: number; size: number } | null
}

/**
 * Record a write that may still be rolled back — an optimistic send that has
 * not reached the container yet. Returns the mark to hand back to
 * {@link revertSessionActivity} if the send fails.
 */
export function recordProvisionalSessionActivity(
  store: SessionStore,
  sessionId: string,
  activityAt: Date | number = Date.now(),
): SessionActivityMark {
  const recordedAtMs = activityAt instanceof Date ? activityAt.getTime() : activityAt
  const slot = getSessionSummaryCacheSlot(store)
  const cached = slot.value?.activityBySession.get(sessionId)
  const previous = cached ? { mtimeMs: cached.mtimeMs, size: cached.size } : null
  recordSessionActivity(store, sessionId, recordedAtMs)
  return { recordedAtMs, previous }
}

/**
 * Undo a provisional record whose send never happened. A no-op if anything
 * newer was recorded since (the entry's mtime moved past the mark), so a
 * late rollback can never erase real activity.
 */
export function revertSessionActivity(
  store: SessionStore,
  sessionId: string,
  mark: SessionActivityMark,
): void {
  const slot = store.summaryCache.peek(store.key)
  if (!slot) return

  const pending = slot.pending.get(sessionId)
  if (pending && !pending.deleted && pending.activityAtMs === mark.recordedAtMs) {
    slot.pending.delete(sessionId)
  }
  const cached = slot.value?.activityBySession.get(sessionId)
  if (cached === undefined || cached.mtimeMs !== mark.recordedAtMs) return
  if (mark.previous) {
    cached.mtimeMs = mark.previous.mtimeMs
    cached.size = mark.previous.size
    return
  }
  // The entry did not exist when the mark was taken (cold/expired cache) and
  // a rebuild has since folded the provisional write into fresh stats. The
  // pre-write mtime is unknown here, so make the next read re-stat.
  slot.revision++
  slot.value = undefined
}

/**
 * Fold a recorded write into a cached entry. A write also proves the
 * transcript is no longer empty, so a file that was a zero-byte placeholder
 * at build time stops being classified as an SDK artifact once it streams.
 */
export function applyActivity(entry: SessionActivityEntry, activityAtMs: number): void {
  entry.mtimeMs = Math.max(entry.mtimeMs, activityAtMs)
  entry.size = Math.max(entry.size, 1)
}

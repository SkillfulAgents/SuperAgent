import { getAgentSessionsDir } from '@shared/lib/utils/file-storage'

export const SESSION_SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * What one transcript stat contributed to the summary. Kept per session so
 * consumers that list sessions (not just count them) can apply the same rules
 * a fresh stat would — empty unregistered files are SDK artifacts, createdAt
 * falls back to birthtime — without touching the transcript again.
 */
export interface SessionActivityEntry {
  mtimeMs: number
  birthtimeMs: number
  size: number
}

export interface SessionSummaryCacheValue {
  directoryMtimeMs: number | null
  builtAtMs: number
  revision: number
  activityBySession: Map<string, SessionActivityEntry>
}

export interface SessionSummaryCacheSlot {
  value?: SessionSummaryCacheValue
  loading?: Promise<SessionSummaryCacheValue>
  revision: number
  pending: Map<string, { activityAtMs?: number; deleted?: true }>
}

// Key by the resolved sessions directory rather than slug: tests and embedded
// deployments can change SUPERAGENT_DATA_DIR in-process, and two roots must
// never share cached state merely because their agent slugs match.
const sessionSummaryCache = new Map<string, SessionSummaryCacheSlot>()

export function getSessionSummaryCacheSlot(sessionsDir: string): SessionSummaryCacheSlot {
  let slot = sessionSummaryCache.get(sessionsDir)
  if (!slot) {
    slot = { revision: 0, pending: new Map() }
    sessionSummaryCache.set(sessionsDir, slot)
  }
  return slot
}

/** Force the next summary read to reconcile ownership and filesystem state. */
export function invalidateSessionSummaryCache(agentSlug: string): void {
  const slot = sessionSummaryCache.get(getAgentSessionsDir(agentSlug))
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
 */
export function recordSessionActivity(
  agentSlug: string,
  sessionId: string,
  activityAt: Date | number = Date.now(),
): void {
  const activityAtMs = activityAt instanceof Date ? activityAt.getTime() : activityAt
  if (!Number.isFinite(activityAtMs)) return
  const slot = getSessionSummaryCacheSlot(getAgentSessionsDir(agentSlug))

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
  agentSlug: string,
  sessionId: string,
  activityAt: Date | number = Date.now(),
): SessionActivityMark {
  const recordedAtMs = activityAt instanceof Date ? activityAt.getTime() : activityAt
  const slot = getSessionSummaryCacheSlot(getAgentSessionsDir(agentSlug))
  const cached = slot.value?.activityBySession.get(sessionId)
  const previous = cached ? { mtimeMs: cached.mtimeMs, size: cached.size } : null
  recordSessionActivity(agentSlug, sessionId, recordedAtMs)
  return { recordedAtMs, previous }
}

/**
 * Undo a provisional record whose send never happened. A no-op if anything
 * newer was recorded since (the entry's mtime moved past the mark), so a
 * late rollback can never erase real activity.
 */
export function revertSessionActivity(
  agentSlug: string,
  sessionId: string,
  mark: SessionActivityMark,
): void {
  const slot = sessionSummaryCache.get(getAgentSessionsDir(agentSlug))
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

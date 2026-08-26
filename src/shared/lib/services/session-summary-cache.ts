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
 * Advance a warm per-agent summary from an authoritative transcript write.
 * This never creates a session in the summary: structural additions are
 * reconciled from the directory, preserving the ownership/filesystem gates.
 */
export function recordSessionActivity(
  agentSlug: string,
  sessionId: string,
  activityAt: Date | number = Date.now(),
): void {
  const activityAtMs = activityAt instanceof Date ? activityAt.getTime() : activityAt
  if (!Number.isFinite(activityAtMs)) return
  const slot = sessionSummaryCache.get(getAgentSessionsDir(agentSlug))
  if (!slot) return

  const cached = slot.value?.activityBySession.get(sessionId)
  if (cached !== undefined) {
    applyActivity(cached, activityAtMs)
  }
  if (slot.loading) {
    const pending = slot.pending.get(sessionId)
    if (!pending?.deleted) {
      slot.pending.set(sessionId, {
        activityAtMs: Math.max(pending?.activityAtMs ?? -Infinity, activityAtMs),
      })
    }
  }
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

export function removeSessionFromSummaryCache(agentSlug: string, sessionId: string): void {
  const slot = sessionSummaryCache.get(getAgentSessionsDir(agentSlug))
  if (!slot) return
  slot.value?.activityBySession.delete(sessionId)
  if (slot.loading) slot.pending.set(sessionId, { deleted: true })
}

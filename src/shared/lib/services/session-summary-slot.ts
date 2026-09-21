/**
 * The shape of one store's warm session summary, and the holder a session
 * store keeps it in. Split from `session-summary-cache` so that a store can
 * carry its cache without depending on the cache's read and write logic —
 * and so a test that mocks that logic still builds real stores.
 */

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

/**
 * One store's warm session summary, held by the store itself: it belongs to
 * the agent's actor and is dropped with it. The slot is bound to the store's
 * storage identity (`key`), not its slug: tests and embedded deployments can
 * change the data directory in-process, and a store whose storage moved must
 * never serve a summary built over the old one.
 */
export class SessionSummaryCache {
  private key: string | undefined
  private slot: SessionSummaryCacheSlot | undefined

  /** The slot for the storage `key` names; a different key than last time starts fresh. */
  slotFor(key: string): SessionSummaryCacheSlot {
    if (!this.slot || this.key !== key) {
      this.key = key
      this.slot = { revision: 0, pending: new Map() }
    }
    return this.slot
  }

  /** The slot if one was built over this storage. */
  peek(key: string): SessionSummaryCacheSlot | undefined {
    return this.key === key ? this.slot : undefined
  }
}

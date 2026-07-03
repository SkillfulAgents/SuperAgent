/**
 * Idempotency gate for Telegram's at-least-once getUpdates: records accepted update ids and
 * reports a repeat so the caller drops a redelivery before it dispatches a second agent turn.
 *
 * Exact-match, not a highest-seen watermark (which would drop an out-of-order lower id and
 * lose a real message). Bounded by COUNT, not time (a TTL could age an id out during a long
 * sleep, just before the resume that redelivers it). Owned by the manager, not the connector,
 * so it survives the connector teardown/recreate of a reconnect — when the redelivery arrives.
 */

const DEFAULT_CAPACITY = 1000

export class UpdateDeduplicator {
  // A Set preserves insertion order, so it doubles as the FIFO eviction queue.
  private readonly seen = new Set<string>()

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /** True if `id` was already accepted (drop it); else records `id` and returns false. */
  isDuplicate(id: string): boolean {
    if (this.seen.has(id)) return true
    this.seen.add(id)
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    return false
  }
}

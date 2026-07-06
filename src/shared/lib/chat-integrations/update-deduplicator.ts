/**
 * Idempotency gate for Telegram's at-least-once getUpdates: records delivered update ids and
 * reports a repeat so the caller drops a redelivery before it dispatches a second agent turn.
 *
 * Check and record are split: `isDuplicate` only reads, and an id is committed with
 * `markDelivered` once its message has actually been handed off. Recording at accept time would
 * make a message that is accepted but then lost in a teardown window (a first-poll batch flushed
 * into an unsubscribed manager, an emit that fires after the manager unsubscribed mid-getFile)
 * permanently lost: the id would be remembered, so the redelivery that used to recover it gets
 * dropped. Record at handoff so a never-delivered update stays eligible for redelivery.
 *
 * Exact-match, not a highest-seen watermark (which would drop an out-of-order lower id and
 * lose a real message). Bounded by COUNT, not time (a TTL could age an id out during a long
 * sleep, just before the resume that redelivers it). Owned by the manager, not the connector,
 * so it survives the connector teardown/recreate of a reconnect - when the redelivery arrives.
 */

const DEFAULT_CAPACITY = 1000

export class UpdateDeduplicator {
  // A Set preserves insertion order, so it doubles as the FIFO eviction queue.
  private readonly seen = new Set<string>()

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /** True if `id` was already delivered. Read-only: checking never records - call
   *  `markDelivered` once the message has been handed off. */
  isDuplicate(id: string): boolean {
    return this.seen.has(id)
  }

  /** Record `id` as delivered, evicting the oldest once capacity is exceeded. Idempotent. */
  markDelivered(id: string): void {
    if (this.seen.has(id)) return
    this.seen.add(id)
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }
}

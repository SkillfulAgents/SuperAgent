const TTL_MS = 15_000
const MAX_DIRECTORIES = 256
const MAX_ENTRIES = 8_000
interface Listing<T> {
  accountId: string
  /** When the source was last read for these entries. Updates a change makes keep it, so a listing
   * changes hands as current only for as long as its read is. */
  readAt: number
  /** When the source last confirmed that nothing changed these entries since `readAt`. */
  checkedAt: number
  entries: T[]
}
const expired = (listing: Listing<unknown>) => listing.readAt + TTL_MS <= Date.now()

/** Shared across request-scoped adapters of one remote source. Each source builds
 * its own listing key. Cache each directory briefly; rclone owns the longer-lived
 * cache. Callers check account access even on a cache hit. No bytes or credentials
 * are retained here. */
export class RemoteListingCache<T> {
  private readonly directories = new Map<string, Listing<T>>()
  private readonly pending = new Map<string, { accountId: string; token: symbol; promise: Promise<T[]> }>()
  private entryCount = 0

  private remove(key: string): void {
    this.entryCount -= this.directories.get(key)?.entries.length ?? 0
    this.directories.delete(key)
  }

  /** Drop one listing, and any read of it in flight. */
  forget(key: string): void {
    this.remove(key)
    this.pending.delete(key)
  }

  invalidate(accountId: string): void {
    for (const [key, listing] of this.directories) if (listing.accountId === accountId) this.remove(key)
    for (const [key, request] of this.pending) if (request.accountId === accountId) this.pending.delete(key)
  }

  /** The retained listing under `key`, if it has not expired. */
  cached(key: string): T[] | undefined {
    const listing = this.directories.get(key)
    if (!listing) return undefined
    if (expired(listing)) { this.remove(key); return undefined }
    this.directories.delete(key)
    this.directories.set(key, listing)
    return listing.entries
  }

  /** The retained listing under `key` if the source was read for it within the last `ms`. */
  recent(key: string, ms: number): { entries: T[]; readAt: number; checkedAt: number } | undefined {
    const listing = this.directories.get(key)
    return listing && listing.readAt >= Date.now() - ms ? listing : undefined
  }

  /** Retain the listing of a folder just made, unless it was read, or a read of it began, since. */
  seed(accountId: string, key: string, entries: T[], readAt: number): void {
    if (this.directories.has(key) || this.pending.has(key)) return
    this.store(accountId, key, entries, readAt)
  }

  /** Retain a listing a change just updated, over any read in flight. `readAt` is when its entries were read. */
  put(accountId: string, key: string, entries: T[], readAt: number, checkedAt = readAt): void {
    this.pending.delete(key)
    this.store(accountId, key, entries, readAt, checkedAt)
  }

  /** Apply a source's report of what changed. `judge` says, from a listing's entries and when it was last
   * checked, whether it no longer matches (dropped), is current (treated as read at `upTo` and checked at
   * `checkedAt`), or cannot be vouched for (left to expire). */
  confirm(accountId: string, upTo: number, checkedAt: number, judge: (key: string, entries: T[], checkedAt: number) => 'stale' | 'current' | 'unknown'): void {
    for (const [key, listing] of this.directories) {
      if (listing.accountId !== accountId) continue
      const verdict = judge(key, listing.entries, listing.checkedAt)
      if (verdict === 'stale') { this.remove(key); continue }
      if (verdict === 'unknown') continue
      listing.readAt = Math.max(listing.readAt, upTo)
      listing.checkedAt = checkedAt
    }
  }

  private store(accountId: string, key: string, entries: T[], readAt: number, checkedAt = readAt): void {
    // Oversized directories are not retained.
    if (entries.length > MAX_ENTRIES) { this.remove(key); return }
    for (const [key, listing] of this.directories) if (expired(listing)) this.remove(key)
    this.remove(key)
    this.directories.set(key, { accountId, entries, readAt, checkedAt })
    this.entryCount += entries.length
    while (this.directories.size > MAX_DIRECTORIES || this.entryCount > MAX_ENTRIES) this.remove(this.directories.keys().next().value!)
  }

  async list(accountId: string, key: string, read: () => Promise<T[]>): Promise<T[]> {
    const cached = this.cached(key)
    if (cached) return cached
    const pending = this.pending.get(key)
    if (pending) return pending.promise
    const token = Symbol()
    const promise = (async () => {
      const readAt = Date.now()
      const entries = await read()
      // A mutation detaches in-flight requests. Their results can finish their
      // original reads, but must not repopulate the cache after invalidation.
      if (this.pending.get(key)?.token === token) this.store(accountId, key, entries, readAt)
      // Oversized directories are returned in full, without retaining their data.
      return entries
    })().finally(() => { if (this.pending.get(key)?.token === token) this.pending.delete(key) })
    this.pending.set(key, { accountId, token, promise })
    return promise
  }
}

const mutations = new Map<string, Promise<unknown>>()

/** Run one change at a time per key: a change waits for every earlier change sharing any of its keys.
 * All keys are claimed at once, so two changes never each hold part of what the other waits for. */
export async function serialize<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
  const pending = Promise.all(keys.map(key => (mutations.get(key) ?? Promise.resolve()).catch(() => {}))).then(operation)
  for (const key of keys) mutations.set(key, pending)
  try { return await pending } finally {
    for (const key of keys) if (mutations.get(key) === pending) mutations.delete(key)
  }
}

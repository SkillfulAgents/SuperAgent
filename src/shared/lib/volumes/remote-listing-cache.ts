const TTL_MS = 15_000
const MAX_DIRECTORIES = 256
const MAX_ENTRIES = 8_000
interface Listing<T> {
  accountId: string
  expiresAt: number
  entries: T[]
}

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
    if (listing.expiresAt <= Date.now()) { this.remove(key); return undefined }
    this.directories.delete(key)
    this.directories.set(key, listing)
    return listing.entries
  }

  async list(accountId: string, key: string, read: () => Promise<T[]>): Promise<T[]> {
    const cached = this.cached(key)
    if (cached) return cached
    const pending = this.pending.get(key)
    if (pending) return pending.promise
    const token = Symbol()
    const promise = (async () => {
      const entries = await read()
      // A mutation detaches in-flight requests. Their results can finish their
      // original reads, but must not repopulate the cache after invalidation.
      if (this.pending.get(key)?.token === token && entries.length <= MAX_ENTRIES) {
        for (const [key, listing] of this.directories) if (listing.expiresAt <= Date.now()) this.remove(key)
        this.remove(key)
        this.directories.set(key, { accountId, entries, expiresAt: Date.now() + TTL_MS })
        this.entryCount += entries.length
        while (this.directories.size > MAX_DIRECTORIES || this.entryCount > MAX_ENTRIES) this.remove(this.directories.keys().next().value!)
      }
      // Oversized directories are returned in full, without retaining their data.
      return entries
    })().finally(() => { if (this.pending.get(key)?.token === token) this.pending.delete(key) })
    this.pending.set(key, { accountId, token, promise })
    return promise
  }
}

const mutations = new Map<string, Promise<unknown>>()

/** Run one change at a time per account, across all its mounts, including overlapping folders. */
export async function serialize<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
  const pending = (mutations.get(accountId) ?? Promise.resolve()).catch(() => {}).then(operation)
  mutations.set(accountId, pending)
  try { return await pending } finally {
    if (mutations.get(accountId) === pending) mutations.delete(accountId)
  }
}

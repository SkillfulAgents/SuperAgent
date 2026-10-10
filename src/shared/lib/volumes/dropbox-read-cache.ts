import type { DropboxMetadata } from './dropbox-schema'

const TTL_MS = 15_000
const MAX_DIRECTORIES = 256
const MAX_ENTRIES = 8_000
interface Listing {
  accountId: string
  expiresAt: number
  entries: DropboxMetadata[]
  metadata: Map<string, DropboxMetadata>
}

const keyOf = (accountId: string, root: string, path: string) => JSON.stringify([accountId, root.toLowerCase(), path.toLowerCase()])

/** Shared across request-scoped adapters. A listing already supplies every child's
 * metadata, so the next folder PROPFIND needn't fetch that metadata again.
 * Cache each directory briefly; rclone owns the longer-lived cache. Callers check
 * account access even on a cache hit. No bytes or credentials are retained here. */
export class DropboxReadCache {
  private readonly directories = new Map<string, Listing>()
  private readonly pending = new Map<string, { accountId: string; token: symbol; promise: Promise<DropboxMetadata[]> }>()
  private entryCount = 0

  private remove(key: string): void {
    this.entryCount -= this.directories.get(key)?.entries.length ?? 0
    this.directories.delete(key)
  }

  invalidate(accountId: string): void {
    for (const [key, listing] of this.directories) if (listing.accountId === accountId) this.remove(key)
    for (const [key, request] of this.pending) if (request.accountId === accountId) this.pending.delete(key)
  }

  private get(key: string): Listing | undefined {
    const listing = this.directories.get(key)
    if (!listing) return undefined
    if (listing.expiresAt <= Date.now()) { this.remove(key); return undefined }
    this.directories.delete(key)
    this.directories.set(key, listing)
    return listing
  }

  metadata(accountId: string, root: string, path: string): DropboxMetadata | undefined {
    const slash = path.lastIndexOf('/')
    return this.get(keyOf(accountId, root, path.slice(0, slash)))?.metadata.get(path.slice(slash + 1).toLowerCase())
  }

  async list(accountId: string, root: string, path: string, read: () => Promise<DropboxMetadata[]>): Promise<DropboxMetadata[]> {
    const key = keyOf(accountId, root, path)
    const cached = this.get(key)
    if (cached) return cached.entries
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
        this.directories.set(key, {
          accountId, entries, expiresAt: Date.now() + TTL_MS,
          metadata: new Map(entries.map(entry => [entry.name.toLowerCase(), entry])),
        })
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

export const dropboxReadCache = new DropboxReadCache()

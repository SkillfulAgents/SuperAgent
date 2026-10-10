import type { DropboxMetadata } from './dropbox-schema'
import { RemoteListingCache } from './remote-listing-cache'

const keyOf = (accountId: string, path: string) => `${accountId}\0${path.toLowerCase()}`
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'))

/** Dropbox listings, keyed by account, root and case-insensitive path. A listing
 * already supplies every child's metadata, so the next folder PROPFIND needn't
 * fetch that metadata again. */
export class DropboxReadCache {
  private readonly listings = new RemoteListingCache<DropboxMetadata>()
  private readonly indexes = new WeakMap<DropboxMetadata[], Map<string, DropboxMetadata>>()

  invalidate(accountId: string): void {
    this.listings.invalidate(accountId)
  }

  metadata(accountId: string, root: string, path: string): DropboxMetadata | undefined {
    if (root && !path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return undefined
    const slash = path.lastIndexOf('/')
    const listing = this.listings.cached(keyOf(accountId, path.slice(0, slash)))
    if (!listing) return undefined
    let index = this.indexes.get(listing)
    if (!index) {
      index = new Map(listing.map(entry => [entry.name.toLowerCase(), entry]))
      this.indexes.set(listing, index)
    }
    return index.get(path.slice(slash + 1).toLowerCase())
  }

  list(accountId: string, root: string, path: string, read: () => Promise<DropboxMetadata[]>): Promise<DropboxMetadata[]> {
    return this.listings.list(accountId, keyOf(accountId, path), read)
  }

  /** Update cached parents from mutation results, preserving their original age.
   * Only affected parents/subtrees are detached, including reads in flight. An
   * uncertain result invalidates those paths without flushing unrelated folders. */
  async change<T>(accountId: string, paths: string[], operation: (settle: (path: string, entry: DropboxMetadata | null) => void) => Promise<T>): Promise<T> {
    paths = paths.map(path => path.toLowerCase())
    const parents = [...new Set(paths.map(parentOf))]
    const before = new Map(parents.map(parent => [parent, this.listings.recent(keyOf(accountId, parent), 15_000)]))
    const updates = new Map<string, DropboxMetadata | null>()
    const forget = () => {
      for (const parent of parents) this.listings.forget(keyOf(accountId, parent))
      for (const path of paths) {
        const prefix = keyOf(accountId, path)
        this.listings.forgetWhere(accountId, key => key === prefix || key.startsWith(`${prefix}/`))
      }
    }
    forget()
    let success = false
    try {
      const result = await operation((path, entry) => { updates.set(path.toLowerCase(), entry) })
      success = true
      return result
    } finally {
      forget()
      if (success) for (const [parent, listing] of before) {
        if (!listing) continue
        let entries = listing.entries
        for (const [path, entry] of updates) if (parentOf(path) === parent) {
          entries = entries.filter(child => child.name.toLowerCase() !== path.slice(path.lastIndexOf('/') + 1).toLowerCase())
          if (entry) entries = [...entries, entry]
        }
        this.listings.put(accountId, keyOf(accountId, parent), entries, listing.readAt, listing.checkedAt)
      }
    }
  }
}

export const dropboxReadCache = new DropboxReadCache()

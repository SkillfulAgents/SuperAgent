import type { DropboxMetadata } from './dropbox-schema'
import { RemoteListingCache } from './remote-listing-cache'

const keyOf = (accountId: string, root: string, path: string) => JSON.stringify([accountId, root.toLowerCase(), path.toLowerCase()])

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
    const slash = path.lastIndexOf('/')
    const listing = this.listings.cached(keyOf(accountId, root, path.slice(0, slash)))
    if (!listing) return undefined
    let index = this.indexes.get(listing)
    if (!index) {
      index = new Map(listing.map(entry => [entry.name.toLowerCase(), entry]))
      this.indexes.set(listing, index)
    }
    return index.get(path.slice(slash + 1).toLowerCase())
  }

  list(accountId: string, root: string, path: string, read: () => Promise<DropboxMetadata[]>): Promise<DropboxMetadata[]> {
    return this.listings.list(accountId, keyOf(accountId, root, path), read)
  }
}

export const dropboxReadCache = new DropboxReadCache()

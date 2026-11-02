/**
 * Bytes by key that outlive this process, for a deployment whose file system does not: one
 * org's API on many short-lived isolates starts every request with an empty data dir. The
 * deployment sets the store once at boot. Desktop and the Node host never set one, and the
 * callers keep their files on disk as before.
 */
export interface BlobStore {
  /** The bytes under `key`, or null when nothing is stored there. */
  get(key: string): Promise<Uint8Array | null>
  put(key: string, bytes: Uint8Array): Promise<void>
  /** A missing key is a no-op. */
  delete(key: string): Promise<void>
}

let current: BlobStore | null = null

export function setBlobStore(store: BlobStore | null): void {
  current = store
}

export function blobStore(): BlobStore | null {
  return current
}

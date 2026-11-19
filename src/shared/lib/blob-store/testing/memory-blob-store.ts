import type { BlobStore } from '../blob-store'

/** A blob store in memory, for tests; `keys()` lists what it holds. */
export function memoryBlobStore(): BlobStore & { keys(): string[] } {
  const blobs = new Map<string, Uint8Array>()
  return {
    get: async (key) => blobs.get(key) ?? null,
    put: async (key, bytes) => {
      blobs.set(key, bytes)
    },
    delete: async (key) => {
      blobs.delete(key)
    },
    keys: () => [...blobs.keys()],
  }
}

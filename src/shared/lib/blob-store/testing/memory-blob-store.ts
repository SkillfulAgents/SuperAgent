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
    list: async (prefix) => [...blobs]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, bytes]) => ({ key, size: bytes.byteLength })),
    stream: async (key) => {
      const bytes = blobs.get(key)
      return bytes ? new Blob([new Uint8Array(bytes)]).stream() : null
    },
    keys: () => [...blobs.keys()],
  }
}

import type { R2Bucket } from 'cloudflare:workers'

/** An R2 bucket in memory, for tests: whole objects, and lists in pages of `pageSize`. */
export function memoryR2Bucket(pageSize = 1000): R2Bucket & { keys(): string[] } {
  const objects = new Map<string, Uint8Array>()
  const bytesOf = async (value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string): Promise<Uint8Array> => {
    if (typeof value === 'string') return new TextEncoder().encode(value)
    if (value instanceof Uint8Array) return value.slice()
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
    return new Uint8Array(await new Response(value).arrayBuffer())
  }
  return {
    keys: () => [...objects.keys()].sort(),
    async get(key) {
      const bytes = objects.get(key)
      if (!bytes) return null
      return { body: new Response(bytes.slice()).body!, arrayBuffer: async () => bytes.slice().buffer }
    },
    async head(key) {
      return objects.has(key) ? {} : null
    },
    async put(key, value) {
      objects.set(key, await bytesOf(value))
      return {}
    },
    async createMultipartUpload(key) {
      const parts = new Map<number, Uint8Array>()
      return {
        async uploadPart(partNumber, value) {
          parts.set(partNumber, await bytesOf(value instanceof ArrayBuffer ? value : value.slice()))
          return { partNumber, etag: `part-${partNumber}` }
        },
        async complete(done) {
          objects.set(key, await bytesOf(new Blob(done.map((part) => parts.get(part.partNumber)! as Uint8Array<ArrayBuffer>)).stream()))
          return {}
        },
        async abort() {
          parts.clear()
        },
      }
    },
    async delete(keys) {
      for (const key of [keys].flat()) objects.delete(key)
    },
    async list(options = {}) {
      const all = [...objects.keys()].sort().filter((key) => key.startsWith(options.prefix ?? ''))
      const start = options.cursor ? Number(options.cursor) : 0
      const page = all.slice(start, start + pageSize)
      const next = start + page.length
      return {
        objects: page.map((key) => ({ key, size: objects.get(key)!.byteLength })),
        truncated: next < all.length,
        ...(next < all.length ? { cursor: String(next) } : {}),
      }
    },
  }
}

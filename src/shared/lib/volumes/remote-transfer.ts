/** Chunk even very large incoming stream chunks into `chunkBytes` pieces, for upload
 * transports that cap each request body. */
import { VolumeError } from './volume-error'

export function throwIfUploadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VolumeError('Upload cancelled by the client', 409)
}

export async function* uploadChunks(body: ReadableStream<Uint8Array>, chunkBytes: number, signal?: AbortSignal): AsyncGenerator<ArrayBuffer> {
  const reader = body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  let buffer = new Uint8Array(chunkBytes)
  let used = 0
  try {
    while (true) {
      throwIfUploadAborted(signal)
      const { value, done } = await reader.read()
      throwIfUploadAborted(signal)
      if (done) break
      for (let offset = 0; offset < value.length;) {
        const count = Math.min(value.length - offset, buffer.length - used)
        buffer.set(value.subarray(offset, offset + count), used)
        used += count
        offset += count
        if (used === buffer.length) {
          yield buffer.buffer
          buffer = new Uint8Array(chunkBytes)
          used = 0
        }
      }
    }
    if (used) yield buffer.slice(0, used).buffer
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Chunk even very large incoming stream chunks into `chunkBytes` pieces, for upload
 * transports that cap each request body. */
export async function* uploadChunks(body: ReadableStream<Uint8Array>, chunkBytes: number): AsyncGenerator<ArrayBuffer> {
  const reader = body.getReader()
  let buffer = new Uint8Array(chunkBytes)
  let used = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
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
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

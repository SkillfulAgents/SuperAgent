export class JsonBodyTooLargeError extends Error {
  constructor() { super('Payload Too Large') }
}

/** Parse bounded JSON; absent or invalid JSON is null. Size and stream errors reject. */
export async function readLimitedJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const body = request.body
  if (!body) return null
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        // Do not wait for the sender or its cancellation hook to finish.
        void reader.cancel().catch(() => {})
        throw new JsonBodyTooLargeError()
      }
      if (value.byteLength) chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  // Decode after joining chunks, since UTF-8 characters can span chunks.
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) } catch { return null }
}

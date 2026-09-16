import type { MiddlewareHandler } from 'hono'

export type LimitedJsonBodyEnv = { Variables: { limitedJsonBody: unknown } }

/** Bound and parse JSON without rebuilding adapter-specific Request objects. */
export function limitJsonBody(maxBytes: number): MiddlewareHandler<LimitedJsonBodyEnv> {
  return async (c, next) => {
    const body = c.req.raw.body
    if (!body) {
      c.set('limitedJsonBody', null)
      return next()
    }
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
          // Do not wait for an oversized sender to finish transmitting.
          void reader.cancel().catch(() => {})
          return c.json({ error: 'Payload Too Large' }, 413)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    // Store parsed data in typed context; leave the original request and its
    // abort signal intact, without relying on the adapter's body-cache internals.
    let parsed: unknown = null
    try { parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) } catch { /* Route schemas reject invalid JSON. */ }
    c.set('limitedJsonBody', parsed)
    return next()
  }
}

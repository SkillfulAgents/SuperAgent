import type { MiddlewareHandler } from 'hono'
import { JsonBodyTooLargeError, readLimitedJsonBody } from '../lib/read-limited-json-body'

export type LimitedJsonBodyEnv = { Variables: { limitedJsonBody: unknown } }

/** Bound and parse JSON without rebuilding adapter-specific Request objects. */
export function limitJsonBody(maxBytes: number): MiddlewareHandler<LimitedJsonBodyEnv> {
  return async (c, next) => {
    try {
      c.set('limitedJsonBody', await readLimitedJsonBody(c.req.raw, maxBytes))
    } catch (error) {
      if (error instanceof JsonBodyTooLargeError) return c.json({ error: 'Payload Too Large' }, 413)
      throw error
    }
    return next()
  }
}

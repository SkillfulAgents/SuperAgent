import type { MiddlewareHandler } from 'hono'

/**
 * Touch the request's AbortSignal before any asynchronous work runs.
 *
 * @hono/node-server materializes the request's AbortController lazily on the
 * first `.signal` access, and its socket-close handler only aborts a controller
 * that already exists at close time — a client hangup that lands before the
 * first access is dropped, and the controller a later access creates never
 * fires. Routes that check `c.req.raw.signal` mid-pipeline (the /messages
 * transcript reads) would then run their full read/parse/serialize path for a
 * client that is already gone. Arming the signal here, synchronously and ahead
 * of every other middleware, guarantees downstream checks observe every hangup.
 */
export const armAbortSignal: MiddlewareHandler = (c, next) => {
  void c.req.raw.signal
  return next()
}

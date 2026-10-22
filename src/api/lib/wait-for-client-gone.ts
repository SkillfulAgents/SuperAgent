import type { SSEStreamingApi } from 'hono/streaming'

/**
 * Resolve once the client behind an SSE response is gone.
 *
 * `stream.onAbort` alone misses two hangups. It only registers a listener, so
 * an abort that already happened is never replayed. And it hears a hangup only
 * through the response body: @hono/node-server does not pipe a body whose
 * socket has already closed, so a client that left before `streamSSE` ran its
 * callback (during the route's middleware or awaits) never aborts the stream.
 * Any write past the first then waits forever for a reader that never comes. The
 * request's AbortSignal does hear that hangup, as long as it was armed before
 * the hangup: `armAbortSignal` arms it for every route, and a route that takes
 * `c.req.raw.signal` before its first await arms it too.
 *
 * So this resolves on either one, immediately if either has already happened.
 * A signal abort also aborts the stream, which rejects a write stuck waiting
 * for a reader (hono swallows the rejection) and runs the stream's own
 * `onAbort` listeners. Resolving twice is harmless.
 *
 * Call it at the top of the stream callback, before the first write, and await
 * the promise once the stream is set up.
 */
export function waitForClientGone(signal: AbortSignal, stream: SSEStreamingApi): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stream.aborted) {
      resolve()
      return
    }
    const abortStream = () => stream.abort()
    stream.onAbort(() => {
      signal.removeEventListener('abort', abortStream)
      resolve()
    })
    if (signal.aborted) {
      abortStream()
      return
    }
    signal.addEventListener('abort', abortStream, { once: true })
  })
}

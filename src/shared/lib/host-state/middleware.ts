import type { MiddlewareHandler } from 'hono'
import { runWithHostState } from './scope'
import type { HostStateStore } from './store'

/**
 * Serves every request inside a host state scope: one settings and host-file
 * snapshot per request, and the response waits for the request's saves. For a
 * deployment that runs the API on many isolates; desktop does not mount it.
 */
export function hostStateMiddleware(store: HostStateStore): MiddlewareHandler {
  return (_c, next) => runWithHostState(store, () => next())
}

import type { MiddlewareHandler } from 'hono'

/** What an API response falls back to when its route makes no caching claim. */
export const DEFAULT_API_CACHE_CONTROL = 'private, no-store'

/**
 * Give every API response a Cache-Control unless its route already set one.
 *
 * An absent Cache-Control is not a neutral choice once a CDN sits in front of a
 * deployment: it falls back to its own extension-based TTL, which is how
 * redelivered workspace files (.mp4, .png) came back stale from the edge — and,
 * worse, how a per-user authorized body ends up in a shared cache that answers
 * the next request without our auth ever running. Almost every API response is
 * per-user and mutable, so uncacheable is the right default.
 *
 * Routes that genuinely want caching set their own header and are left
 * untouched: the public polyfill bundles, hashed-name model icons, immutable
 * session media, and SSE endpoints (Hono's streamSSE sets no-cache itself).
 */
export const defaultCacheControl: MiddlewareHandler = async (c, next) => {
  await next()
  if (!c.res.headers.has('cache-control')) {
    c.res.headers.set('cache-control', DEFAULT_API_CACHE_CONTROL)
  }
}

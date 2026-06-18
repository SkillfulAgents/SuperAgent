import { getApiBaseUrl } from './env'

/**
 * Fetch wrapper that prepends the API base URL.
 * In web mode, this is empty (same-origin).
 * In Electron, this is http://localhost:{port} where port is dynamically assigned.
 *
 * In auth mode, automatically signs out on 401 responses (expired session).
 */
export async function apiFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const baseUrl = getApiBaseUrl()
  const response = await fetch(`${baseUrl}${path}`, init)

  // Auto-sign-out on 401 in auth mode (skip auth endpoints to avoid loops).
  // Stash the current URL FIRST so any successful in-place re-sign-in restores it.
  // Only on 401 (expired) — never 403 (forbidden). AUTH_MODE is web-only,
  // so pathname+search is the route; the hash is included for completeness.
  if (__AUTH_MODE__ && response.status === 401 && !path.startsWith('/api/auth/')) {
    const here = window.location.pathname + window.location.search + window.location.hash
    if (here !== '/') sessionStorage.setItem(REDIRECT_KEY, here)
    const { signOut } = await import('./auth-client')
    await signOut().catch(() => {}) // session may already be gone
  }

  return response
}

const REDIRECT_KEY = 'superagent.redirect'

/**
 * A safe internal path. Must start with a single `/` and reject anything the
 * router/browser could resolve into an off-site (open-redirect) navigation:
 * `//host` and `/\host` (protocol-relative / UNC), and a leading encoded
 * separator (`/%2f…`, `/%5c…`) that would decode into one. A deeper encoded `%2f`
 * (in a query, say) is fine — only a leading one is dangerous. Current callers
 * pass browser-normalized `window.location.*`; this is the open-redirect backstop
 * for any future caller that stashes a hand-built path.
 */
export function isSafeInternalPath(p: string | null): p is string {
  if (!p) return false
  if (!/^\/(?![/\\])/.test(p)) return false // single leading slash only
  if (/^\/(?:%2f|%5c)/i.test(p)) return false // encoded separator right after it
  return true
}

/**
 * Read AND clear the post-login redirect stash, validated as a safe internal
 * path (open-redirect guard). Used by the email-login restore.
 */
export function consumeRedirectStash(): string | null {
  const raw = sessionStorage.getItem(REDIRECT_KEY)
  sessionStorage.removeItem(REDIRECT_KEY)
  return isSafeInternalPath(raw) ? raw : null
}

/**
 * Read (WITHOUT clearing) the redirect stash as a safe internal path, defaulting
 * to `/`. Used for the OAuth `callbackURL` (the round-trip leaves the SPA, so the
 * destination must travel with it rather than be restored in-place).
 */
export function peekRedirectStash(): string {
  const raw = sessionStorage.getItem(REDIRECT_KEY)
  return isSafeInternalPath(raw) ? raw : '/'
}

/** Drop the redirect stash. Called on sign-out so a signed-out user's path can't
 * be restored into the NEXT user's session on a shared tab (a no-clobber stash
 * would otherwise leak it). */
export function clearRedirectStash(): void {
  sessionStorage.removeItem(REDIRECT_KEY)
}

/**
 * Stash an internal path so a subsequent login restores it — via the OAuth
 * `callbackURL` (`peekRedirectStash`) or in-place email login
 * (`consumeRedirectStash`). Called when the auth screen is about to render for a
 * signed-out user on a COLD load: a cold deep-link (e.g. `/agents/foo`)
 * never mounts the router and so never fires an API call, meaning the 401 handler
 * above never runs and the deep link would otherwise be lost — OAuth's
 * `callbackURL` would default to `/`. No-op outside auth mode; skips `/` (the
 * default) and non-safe paths. Overwrites any existing entry so the newest
 * deep-link intent wins (consistent with the 401 handler above); the caller is
 * responsible for only invoking this on a genuine cold load, never on sign-out.
 */
export function stashRedirectTarget(path: string): void {
  if (!__AUTH_MODE__) return
  if (path === '/' || !isSafeInternalPath(path)) return
  sessionStorage.setItem(REDIRECT_KEY, path)
}

/**
 * Thrown by `apiJson` on a non-2xx response, carrying the HTTP status so route
 * loaders can map it: 403/404 → `notFound()`, 5xx/network → `errorComponent`.
 */
export class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
  }
}

/**
 * Loader-only fetch: returns parsed JSON, throwing `HttpError` on a non-2xx
 * response. The existing data hooks stay on `apiFetch` (which never throws and
 * renders its own inline loading/empty states); loaders need a throw to gate
 * access before the route renders.
 */
export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init)
  if (!res.ok) throw new HttpError(res.status)
  return res.json() as Promise<T>
}

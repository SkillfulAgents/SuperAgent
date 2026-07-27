import { getApiBaseUrl } from './env'
import { hasInteractiveLogin } from './auth-mode'

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

  // A 401 means three different things depending on what we're talking to, so
  // the handling is three-way (skip auth endpoints throughout, to avoid loops):
  //
  //   local API   — auth is off; nothing to do.
  //   web auth    — the session expired: stash the route and sign out, below.
  //   cloud       — do NOT sign out. There is no password to re-enter, and
  //                 better-auth's signOut() would try to revoke the *deployment*
  //                 session that the desktop's grant is bound to. The proxy has
  //                 already tried to re-mint and retried once (see
  //                 cloud-proxy.ts), so a 401 arriving here means that failed —
  //                 the workspace needs reconnecting, which AuthGate surfaces
  //                 when the session reads null.
  //
  // Only on 401 (expired) — never 403 (forbidden), and never while a deliberate
  // sign-out is in effect: revoking the session 401s every trailing background
  // request, and without the gate those would re-stash the signed-out user's
  // URL right after clearRedirectStash() dropped it (shared-tab leak).
  if (
    hasInteractiveLogin() &&
    response.status === 401 &&
    !deliberateSignOut &&
    !path.startsWith('/api/auth/')
  ) {
    // Interactive login is web-only, so pathname+search is the route; the hash
    // is included for completeness.
    const here = window.location.pathname + window.location.search + window.location.hash
    if (here !== '/') sessionStorage.setItem(REDIRECT_KEY, here)
    const { signOut } = await import('./auth-client')
    await signOut().catch(() => {}) // session may already be gone
  }

  return response
}

const REDIRECT_KEY = 'superagent.redirect'

// Latched while a deliberate sign-out is in effect, gating the 401 branch
// above. Module state, so a full page load naturally resets it; the warm
// reset happens when the next session authenticates.
let deliberateSignOut = false

/** Called by the user-context sign-out before revoking the session. */
export function markDeliberateSignOut(): void {
  deliberateSignOut = true
}

/** Called once a session is authenticated again, re-arming the 401 handler. */
export function clearDeliberateSignOut(): void {
  deliberateSignOut = false
}

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
 *
 * No-op unless there is an interactive login to come back from — a cloud
 * workspace has none, so there would be nothing to consume the stash.
 */
export function stashRedirectTarget(path: string): void {
  if (!hasInteractiveLogin()) return
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

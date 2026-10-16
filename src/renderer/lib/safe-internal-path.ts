/**
 * A safe internal path. Must start with a single `/` and reject anything the
 * router/browser could resolve into an off-site (open-redirect) navigation:
 * `//host` and `/\host` (protocol-relative / UNC), and a leading encoded
 * separator (`/%2f…`, `/%5c…`) that would decode into one. A deeper encoded `%2f`
 * (in a query, say) is fine — only a leading one is dangerous. Current callers
 * pass browser-normalized `window.location.*`; this is the open-redirect backstop
 * for any future caller that stashes a hand-built path.
 *
 * Lives here, not in api.ts, so router schemas and Markdown can share it without
 * loading the API client (tests often mock `@renderer/lib/api` incompletely).
 */
export function isSafeInternalPath(p: string | null): p is string {
  if (!p) return false
  if (!/^\/(?![/\\])/.test(p)) return false // single leading slash only
  if (/^\/(?:%2f|%5c)/i.test(p)) return false // encoded separator right after it
  return true
}

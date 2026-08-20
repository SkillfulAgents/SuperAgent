import { getApiBaseUrl } from './env'
import { hasInteractiveLogin, isAuthMode } from './auth-mode'
import { reportCloudSessionRejected } from './cloud-session'
import { captureRendererException } from './error-reporting'

const SAFE_ROUTE_SEGMENTS = new Set([
  'api', 'accounts', 'agents', 'answer', 'auth', 'automations', 'billing', 'browser',
  'cancel', 'chat-integrations', 'connections', 'credential', 'dashboards', 'deploy',
  'events', 'files', 'folders', 'health', 'history', 'import', 'integrations', 'logs',
  'messages', 'models', 'notifications', 'platform', 'preferences', 'refresh', 'roles',
  'runtime-status', 'secrets', 'sessions', 'settings', 'skillsets', 'status', 'subagents',
  'sync', 'typing', 'unread', 'update', 'usage', 'validate', 'workflows',
])

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

type ApiRequestFailureKind =
  | 'offline'
  | 'intentional_navigation_abort'
  | 'aborted'
  | 'transport_or_cors'
  | 'forbidden'
  | 'server'

type ApiRequestMetadata = {
  route: string
  method: string
  failureKind: ApiRequestFailureKind
  statusClass: 'none' | '4xx' | '5xx'
  status?: number
  policyCode?: string
  apiBaseKind: 'same-origin' | 'loopback' | 'other-first-party'
  browser: 'firefox' | 'safari' | 'chromium' | 'embedded' | 'other'
  online: 'yes' | 'no' | 'unknown'
  visibility: 'visible' | 'hidden' | 'unknown'
  lifecycle: 'active' | 'pagehide'
  elapsedMsBucket: '<100' | '100-999' | '1000-9999' | '10000+'
}

let pageLifecycle: 'active' | 'pagehide' = 'active'
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { pageLifecycle = 'pagehide' })
  window.addEventListener('pageshow', () => { pageLifecycle = 'active' })
}

/**
 * A request failure whose public fields are safe to send to diagnostics. The
 * original URL, response body, headers and provider error are deliberately not
 * retained, including as `cause` (Sentry recursively serializes causes).
 */
export class ApiRequestError extends Error {
  constructor(public readonly metadata: ApiRequestMetadata) {
    super(`API request failed: ${metadata.method} ${metadata.route} (${metadata.failureKind})`)
    this.name = 'ApiRequestError'
  }
}

/** Only a caller-owned abort coincident with page teardown is proven intentional. */
export function isProvenIntentionalApiAbort(error: unknown): boolean {
  return error instanceof ApiRequestError && error.metadata.failureKind === 'intentional_navigation_abort'
}

function normalizedMethod(init?: RequestInit): string {
  const method = (init?.method ?? 'GET').toUpperCase()
  return HTTP_METHODS.has(method) ? method : 'OTHER'
}

/**
 * Retain only a small allowlist of route vocabulary. Every other segment is a
 * parameter, so slugs, account/session IDs, tokens and encoded values cannot
 * enter diagnostics. Query strings and fragments are discarded before parsing.
 */
export function normalizeApiRoute(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0]
  if (!pathname.startsWith('/api/')) return '/api/:unknown'
  const segments = pathname.split('/').filter(Boolean)
  return `/${segments.map((segment) => SAFE_ROUTE_SEGMENTS.has(segment.toLowerCase())
    ? segment.toLowerCase()
    : ':param').join('/')}`
}

function apiBaseKind(baseUrl: string): ApiRequestMetadata['apiBaseKind'] {
  if (!baseUrl) return 'same-origin'
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
      ? 'loopback'
      : 'other-first-party'
  } catch {
    return 'other-first-party'
  }
}

function browserKind(): ApiRequestMetadata['browser'] {
  if (typeof navigator === 'undefined') return 'other'
  const ua = navigator.userAgent.toLowerCase()
  if (/\b(fbav|instagram|line|wv)\b/.test(ua)) return 'embedded'
  if (ua.includes('firefox')) return 'firefox'
  if (ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium')) return 'safari'
  if (ua.includes('chrome') || ua.includes('chromium')) return 'chromium'
  return 'other'
}

function elapsedBucket(elapsedMs: number): ApiRequestMetadata['elapsedMsBucket'] {
  if (elapsedMs < 100) return '<100'
  if (elapsedMs < 1_000) return '100-999'
  if (elapsedMs < 10_000) return '1000-9999'
  return '10000+'
}

function safePolicyCode(response: Response): string | undefined {
  // This explicitly allowlisted machine code is the only response metadata read.
  // Request IDs and bodies are intentionally excluded by the global privacy rule.
  const value = response.headers?.get?.('x-error-code')
  return value && /^[A-Z][A-Z0-9_]{0,31}$/.test(value) ? value : undefined
}

function requestMetadata(
  path: string,
  init: RequestInit | undefined,
  baseUrl: string,
  startedAt: number,
  failureKind: ApiRequestFailureKind,
  status?: number,
  policyCode?: string,
): ApiRequestMetadata {
  return {
    route: normalizeApiRoute(path),
    method: normalizedMethod(init),
    failureKind,
    statusClass: status === undefined ? 'none' : status >= 500 ? '5xx' : '4xx',
    ...(status === undefined ? {} : { status }),
    ...(policyCode ? { policyCode } : {}),
    apiBaseKind: apiBaseKind(baseUrl),
    browser: browserKind(),
    online: typeof navigator === 'undefined' ? 'unknown' : navigator.onLine ? 'yes' : 'no',
    visibility: typeof document === 'undefined'
      ? 'unknown'
      : document.visibilityState === 'hidden' ? 'hidden' : 'visible',
    lifecycle: pageLifecycle,
    elapsedMsBucket: elapsedBucket(performance.now() - startedAt),
  }
}

function reportApiRequestFailure(error: ApiRequestError): void {
  const { metadata } = error
  captureRendererException(error, {
    tags: {
      source: 'api-fetch',
      route: metadata.route,
      method: metadata.method,
      failure_kind: metadata.failureKind,
      status_class: metadata.statusClass,
      api_base_kind: metadata.apiBaseKind,
      browser: metadata.browser,
      online: metadata.online,
      visibility: metadata.visibility,
      lifecycle: metadata.lifecycle,
      ...(metadata.policyCode ? { policy_code: metadata.policyCode } : {}),
    },
    extra: {
      status: metadata.status,
      elapsed_ms_bucket: metadata.elapsedMsBucket,
    },
    fingerprint: ['api-request', metadata.route, metadata.method, metadata.failureKind],
  })
}

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
  const startedAt = performance.now()
  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, init)
  } catch (cause) {
    const aborted = init?.signal?.aborted === true || (cause instanceof DOMException && cause.name === 'AbortError')
    const failureKind: ApiRequestFailureKind = typeof navigator !== 'undefined' && navigator.onLine === false
      ? 'offline'
      : aborted && pageLifecycle === 'pagehide'
        ? 'intentional_navigation_abort'
        : aborted
          ? 'aborted'
          : 'transport_or_cors'
    const error = new ApiRequestError(requestMetadata(path, init, baseUrl, startedAt, failureKind))
    if (failureKind !== 'intentional_navigation_abort') reportApiRequestFailure(error)
    throw error
  }

  if (response.status === 403 || response.status >= 500) {
    const failureKind: ApiRequestFailureKind = response.status === 403 ? 'forbidden' : 'server'
    reportApiRequestFailure(new ApiRequestError(requestMetadata(
      path,
      init,
      baseUrl,
      startedAt,
      failureKind,
      response.status,
      response.status === 403 ? safePolicyCode(response) : undefined,
    )))
  }

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
  if (response.status === 401 && !path.startsWith('/api/auth/') && isAuthMode()) {
    if (hasInteractiveLogin()) {
      if (!deliberateSignOut) {
        // Interactive login is web-only, so pathname+search is the route; the
        // hash is included for completeness.
        const here = window.location.pathname + window.location.search + window.location.hash
        if (here !== '/') sessionStorage.setItem(REDIRECT_KEY, here)
        const { signOut } = await import('./auth-client')
        await signOut().catch(() => {}) // session may already be gone
      }
    } else {
      // Cloud. Returning the 401 is not enough on its own: the session store
      // holds its last good value, so the UI would keep claiming to be signed in
      // while every query failed behind it. Ask for a session re-check instead.
      reportCloudSessionRejected()
    }
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

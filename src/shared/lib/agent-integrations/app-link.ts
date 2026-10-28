import { getTrustedOrigins } from '../auth/trusted-origins'

/** Where to send the user when an integration can't fulfill a request. */
export interface AppLinkContext {
  isDesktop: boolean
  url: string | null
}

/** Canonical public base for integration links and OAuth callbacks.
 * HOST_PUBLIC_URL takes precedence, then the documented first trusted origin.
 * Client-supplied forwarded headers cannot select the callback host or protocol.
 */
export function resolvePublicAppBaseUrl(request?: Request | string): string | null {
  const configured = process.env.HOST_PUBLIC_URL?.trim() || getTrustedOrigins()[0]?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  if (!request) return null
  return URL.parse(typeof request === 'string' ? request : request.url)?.origin ?? null
}

const LOOPBACK_OR_PRIVATE_HOST = /^(localhost|.*\.local|127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|0\.0\.0\.0|\[?::1\]?|\[?fc[0-9a-f]{2}:.*|\[?fd[0-9a-f]{2}:.*|\[?fe80:.*)$/i

/**
 * The URL a machine on the public internet can load this app at, or null.
 * Only `HOST_PUBLIC_URL` counts, and only when it is https and not a loopback
 * or private address: trusted origins and request hosts describe where
 * browsers come from, not where a third-party service can reach us. Features
 * that hand a page to an outside service (a meeting bot's camera) gate on this.
 */
export function resolveInternetAppBaseUrl(): string | null {
  const configured = process.env.HOST_PUBLIC_URL?.trim()
  if (!configured) return null
  const url = URL.parse(configured)
  if (!url || url.protocol !== 'https:' || LOOPBACK_OR_PRIVATE_HOST.test(url.hostname)) return null
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/**
 * Resolve the app surface + optional deep/web link for an agent.
 * Env reads stay inside this function (SUPERAGENT_PROTOCOL is assigned after
 * this module is imported in Electron main).
 */
export function resolveAppLinkContext(agentSlug: string): AppLinkContext {
  if (process.type === 'browser') {
    // `||`, not `??`: an empty value must fall back too, or the link degrades to
    // a scheme-less `://agent/…` that chat clients still render as a dead link.
    const scheme = process.env.SUPERAGENT_PROTOCOL || 'superagent'
    return { isDesktop: true, url: `${scheme}://agent/${encodeURIComponent(agentSlug)}` }
  }
  const base = resolvePublicAppBaseUrl()
  return { isDesktop: false, url: base ? `${base}/agents/${encodeURIComponent(agentSlug)}` : null }
}

/**
 * Session-scoped variant of an app link: suffix the session path onto the base
 * link. Passthrough when there is no base URL (self-hosted cloud) or no session
 * identity (link stays agent-home). One rule serves both surfaces because the
 * desktop and web base shapes are parallel.
 */
export function withSessionUrl(
  appLink: AppLinkContext | undefined,
  sessionId?: string,
): AppLinkContext | undefined {
  if (!appLink?.url || !sessionId) return appLink
  const base = appLink.url.replace(/\/+$/, '')
  return { ...appLink, url: `${base}/sessions/${encodeURIComponent(sessionId)}` }
}

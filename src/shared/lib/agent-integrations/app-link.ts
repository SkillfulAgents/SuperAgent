/** Where to send the user when an integration can't fulfill a request. */
export interface AppLinkContext {
  isDesktop: boolean
  url: string | null
}

/** Canonical public base for integration links and OAuth callbacks.
 * Reverse proxies must overwrite forwarded host/proto headers at the edge.
 * HOST_PUBLIC_URL takes precedence, including deployments under a path prefix.
 */
export function resolvePublicAppBaseUrl(request?: Request | string): string | null {
  const configured = process.env.HOST_PUBLIC_URL?.trim().replace(/\/+$/, '')
  if (configured) return configured
  if (!request) return null
  const url = URL.parse(typeof request === 'string' ? request : request.url)
  if (!url) return null
  if (typeof request === 'string') return url.origin
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0].trim()
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0].trim()
  // A forwarded host replaces the internal port too. Preserve host/port when
  // only TLS termination is forwarded; reject paths, user-info and non-HTTP schemes.
  const host = forwardedHost && !/[\s/\\?#@]/.test(forwardedHost) ? forwardedHost : url.host
  const protocol = forwardedProtocol === 'https' || forwardedProtocol === 'http' ? `${forwardedProtocol}:` : url.protocol
  return URL.parse(`${protocol}//${host}`)?.origin ?? url.origin
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

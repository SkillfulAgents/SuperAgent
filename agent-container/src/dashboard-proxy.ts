import type { IncomingMessage } from 'http'
import type { DashboardUpstreamPathMode } from './dashboard-manager'

export interface DashboardProxyRoute {
  slug: string
  subPath: string
}

const DASHBOARD_SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** Do not expose the host-to-container credential to agent-authored servers. */
export function dashboardHttpForwardHeaders(source: Record<string, string>): Headers {
  const headers = new Headers(source)
  headers.delete('host')
  headers.delete('x-superagent-host-token')
  return headers
}

export function parseDashboardProxyRoute(pathname: string): DashboardProxyRoute | null {
  const match = pathname.match(/^\/artifacts\/([^/]+)(\/.*)?$/)
  if (!match) return null

  let slug: string
  try {
    slug = decodeURIComponent(match[1])
  } catch {
    return null
  }
  if (!DASHBOARD_SLUG.test(slug)) return null
  return { slug, subPath: match[2] || '/' }
}

const SKIP_WEBSOCKET_HEADERS = new Set([
  'connection',
  'host',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'upgrade',
  'x-superagent-host-token',
])

export function dashboardWebSocketForwardHeaders(
  request: Pick<IncomingMessage, 'headers'>,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || SKIP_WEBSOCKET_HEADERS.has(name.toLowerCase())) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

export function requestedWebSocketProtocols(
  request: Pick<IncomingMessage, 'headers'>,
): string[] {
  const raw = request.headers['sec-websocket-protocol']
  const value = Array.isArray(raw) ? raw.join(',') : raw
  return value ? value.split(',').map((protocol) => protocol.trim()).filter(Boolean) : []
}

function mountedDashboardPath(subPath: string, publicBasePath: string | null): string {
  if (!publicBasePath?.startsWith('/')) return subPath

  const mount = publicBasePath.endsWith('/') ? publicBasePath.slice(0, -1) : publicBasePath
  return subPath === '/' ? `${mount}/` : `${mount}${subPath.startsWith('/') ? '' : '/'}${subPath}`
}

/** Select the URL path presented to the dashboard's HTTP server. */
export function dashboardHttpUpstreamPath(
  subPath: string,
  publicBasePath: string | null,
  mode: DashboardUpstreamPathMode,
): string {
  return mode === 'mounted' ? mountedDashboardPath(subPath, publicBasePath) : subPath
}

/**
 * Mounted dashboards retain their public base for every socket. In the default
 * stripped mode, Vite HMR is the sole exception because Vite validates upgrade
 * paths against its browser-visible `base`.
 */
export function dashboardWebSocketUpstreamPath(
  subPath: string,
  protocols: string[],
  publicBasePath: string | null,
  mode: DashboardUpstreamPathMode = 'stripped',
): string {
  if (mode === 'mounted') return mountedDashboardPath(subPath, publicBasePath)
  if (!protocols.some((protocol) => protocol === 'vite-hmr' || protocol === 'vite-ping')) {
    return subPath
  }
  return mountedDashboardPath(subPath, publicBasePath)
}

import { Hono } from 'hono'
import type { Context } from 'hono'
import { IsAgent } from '../middleware/auth'
import { attribution } from '@shared/lib/platform-attribution'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import {
  buildClientHeaders,
  buildUpstreamHeaders,
} from '@shared/lib/platform-services/forward-headers'

const ALLOWED_SERVICES = new Set(['replicate'])

const services = new Hono()

// IsAgent: proxy-token gate + agent-owner attribution scope for billed proxy calls.
services.use('*', IsAgent())

/**
 * Slice the path after `/api/services/:service` (or `/:service` when the
 * sub-app sees a relative URL). Preserve percent-encoding by reading the
 * request URL string rather than relying on Hono's `*` param.
 */
function extractServiceRest(requestUrl: string, service: string): { rest: string; search: string } {
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const url = new URL(requestUrl)
  const pathname = url.pathname
  const fullPrefix = `/api/services/${service}`
  const localPrefix = `/${service}`

  let rest = ''
  if (pathname === fullPrefix || pathname.startsWith(`${fullPrefix}/`)) {
    rest = pathname.slice(fullPrefix.length)
  } else if (pathname === localPrefix || pathname.startsWith(`${localPrefix}/`)) {
    rest = pathname.slice(localPrefix.length)
  }

  return { rest, search: url.search }
}

async function forwardService(c: Context) {
  const service = c.req.param('service')
  if (!service || !ALLOWED_SERVICES.has(service)) {
    return c.json({ error: 'Unknown service' }, 404)
  }

  const proxyBase = getPlatformProxyBaseUrl()
  if (!proxyBase) {
    return c.json({ error: 'Platform proxy is not configured' }, 503)
  }

  const auth = attribution.current()
  if (attribution.requiresActingMember() && !auth) {
    return c.json({ error: 'Platform attribution unavailable' }, 503)
  }

  const bearer = auth?.bearerToken() ?? getPlatformAccessToken()
  if (!bearer) {
    return c.json({ error: 'Platform token is not configured' }, 503)
  }

  const { rest, search } = extractServiceRest(c.req.url, service)
  const targetUrl = `${proxyBase}/v1/${service}${rest}${search}`
  const request = c.req.raw
  // Emptiness from HTTP framing, not request.body — Node's adapter gives every
  // non-GET/HEAD a ReadableStream even when no bytes follow (same trap as
  // cloud-proxy readForwardableBody).
  const declared = request.headers.get('content-length')
  const chunked = request.headers.get('transfer-encoding') !== null
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? null
      : !chunked && (declared === null || Number(declared) === 0)
        ? null
        : request.body

  let upstream: Response
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request, bearer),
      body,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      redirect: 'manual',
      signal: request.signal,
    } as RequestInit)
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 })
    }
    console.error('[services] Upstream request failed:', error)
    return c.json({ error: 'Platform service unreachable' }, 502)
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildClientHeaders(upstream),
  })
}

// Bare /:service and /:service/* — do not rely on Hono `*` for the rest path.
services.all('/:service', forwardService)
services.all('/:service/*', forwardService)

export default services

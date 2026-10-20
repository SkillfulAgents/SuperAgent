import { Hono } from 'hono'
import { IsAgent } from '../middleware/auth'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformContainerToken } from '@shared/lib/platform-attribution/container-token'
import { PROXY_SKIP_REQUEST_HEADERS, PROXY_SKIP_RESPONSE_HEADERS } from '@shared/lib/proxy/composio-envelope'
import { captureMessage } from '@shared/lib/error-reporting'

// The platform routes agents call. Drives, connected accounts and the rest stay with the app.
const AGENT_ROUTES = ['/v1/messages', '/v1/exa', '/v1/openai', '/v1/apollo', '/v1/replicate', '/v1/x']
const reportedRefusals = new Set<string>()

const platformProxy = new Hono<{ Variables: { agentSlug: string } }>()

platformProxy.use('*', IsAgent())

platformProxy.all('/*', async (c) => {
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const url = new URL(c.req.url)
  const path = url.pathname.replace(/^\/api\/platform-proxy/, '')
  if (!AGENT_ROUTES.some((route) => path === route || path.startsWith(`${route}/`))) {
    if (!reportedRefusals.has(c.get('agentSlug'))) {
      reportedRefusals.add(c.get('agentSlug'))
      captureMessage('platform relay refused a route', {
        level: 'warning',
        tags: { area: 'platform-relay', op: 'route.refused' },
        extra: { agentSlug: c.get('agentSlug'), path },
      })
    }
    return c.json({ error: 'This platform route is not available to agents' }, 403)
  }
  // Outside auth mode the Platform provider also accepts the env token on its own.
  const token = await getPlatformContainerToken(c.get('agentSlug')) ?? process.env.PLATFORM_TOKEN
  if (!token) return c.json({ error: 'Platform is not connected' }, 503)

  const headers = new Headers()
  c.req.raw.headers.forEach((value, key) => {
    if (!PROXY_SKIP_REQUEST_HEADERS.has(key)) headers.set(key, value)
  })
  headers.set('authorization', `Bearer ${token}`)
  const upstream = await fetch(`${getPlatformProxyBaseUrl()}${path}${url.search}`, {
    method: c.req.method,
    headers,
    body: c.req.raw.body,
    duplex: 'half',
    redirect: 'manual',
    signal: c.req.raw.signal,
  } as RequestInit)

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    if (!PROXY_SKIP_RESPONSE_HEADERS.has(key)) responseHeaders.set(key, value)
  })
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
})

export default platformProxy

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'

vi.mock('../middleware/auth', () => ({
  IsAgent: (): MiddlewareHandler => async (c, next) => {
    if (c.req.header('Authorization') !== 'Bearer synth_agent') return c.json({ error: 'Unauthorized' }, 401)
    c.set('agentSlug' as never, 'alpha' as never)
    return next()
  },
}))
const platformToken = vi.fn(async (slug: string): Promise<string | undefined> => `org-jwt::owner-of-${slug}`)
vi.mock('@shared/lib/platform-attribution/container-token', () => ({
  getPlatformContainerToken: (slug: string) => platformToken(slug),
}))
vi.mock('@shared/lib/error-reporting', () => ({ captureMessage: vi.fn() }))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.example',
}))

import platformProxy from './platform-proxy'

const app = new Hono().route('/api/platform-proxy', platformProxy)
const upstream = vi.fn<typeof fetch>()

beforeEach(() => {
  upstream.mockReset().mockResolvedValue(new Response('event: done\n\n', { status: 201, headers: { 'content-type': 'text/event-stream' } }))
  vi.stubGlobal('fetch', upstream)
})
afterEach(() => vi.unstubAllGlobals())

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api/platform-proxy${path}`, { ...init, headers: { Authorization: 'Bearer synth_agent', ...init.headers } })

describe('platform relay', () => {
  it('forwards an agent route with the real platform token in place of the proxy token', async () => {
    const res = await call('/v1/messages?beta=true', { method: 'POST', body: '{"model":"m"}', headers: { 'content-type': 'application/json' } })

    expect(res.status).toBe(201)
    expect(await res.text()).toBe('event: done\n\n')
    const [url, init] = upstream.mock.calls[0]!
    expect(url).toBe('https://proxy.example/v1/messages?beta=true')
    const sent = new Headers(init!.headers)
    expect(sent.get('authorization')).toBe('Bearer org-jwt::owner-of-alpha')
    expect(sent.get('content-type')).toBe('application/json')
    expect(init!.redirect).toBe('manual')
    expect(await new Response(init!.body).text()).toBe('{"model":"m"}')
  })

  it.each([
    '',
    '/v1/volumes',
    '/v1/volumes/d1/credentials',
    '/v1/composio/connections',
    '/v1/revoke',
    '/v1/exa/../volumes/d1/credentials',
    '/v1/exa/%2e%2e/volumes/d1/credentials',
    '/v1/x-other',
  ])('refuses %s without reaching the platform', async (path) => {
    const res = await call(path, { method: 'POST' })
    expect(res.status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('answers 503 without reaching the platform when the platform is not connected', async () => {
    platformToken.mockResolvedValueOnce(undefined)
    const res = await call('/v1/exa/search', { method: 'POST' })
    expect(res.status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('refuses a caller without a valid proxy token', async () => {
    const res = await app.request('/api/platform-proxy/v1/exa/search', { method: 'POST', headers: { Authorization: 'Bearer org-jwt' } })
    expect(res.status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })
})

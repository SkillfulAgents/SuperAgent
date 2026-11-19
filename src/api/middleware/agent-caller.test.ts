import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

// The one statement this file counts: a `proxy_tokens` lookup per call.
const validateProxyToken = vi.hoisted(() => vi.fn(async (token: string): Promise<string | null> => (
  token === 'agent-token' ? 'agent' : token === 'other-token' ? 'other' : null
)))
vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken }))

const { requireAgentCaller } = await import('./agent-caller')
const { default: xAgent } = await import('../routes/x-agent')
const { default: xAgentChat } = await import('../routes/x-agent-chat')
const { default: xAgentIntegrations } = await import('../routes/x-agent-integrations')
const { default: xAgentMeetings } = await import('../routes/x-agent-meetings')
const { default: xAgentRules } = await import('../routes/x-agent-rules')
const { default: xAgentSessions } = await import('../routes/x-agent-sessions')
const { default: xAgentSkills } = await import('../routes/x-agent-skills')

const subRouters = {
  chat: xAgentChat,
  integrations: xAgentIntegrations,
  meetings: xAgentMeetings,
  rules: xAgentRules,
  sessions: xAgentSessions,
  skills: xAgentSkills,
} as const
type SubRouterName = keyof typeof subRouters
const names = Object.keys(subRouters) as SubRouterName[]

const mountSubRouters = (app: Hono) => {
  for (const name of names) app.route(`/api/x-agent/${name}`, subRouters[name])
  return app
}

// The shape src/api/index.ts mounts: the parent first, whose `use('*')` also
// matches everything beneath `/api/x-agent`, then each sub-router.
const asMounted = () => mountSubRouters(new Hono().route('/api/x-agent', xAgent))
const subRoutersFirst = () => mountSubRouters(new Hono()).route('/api/x-agent', xAgent)
const alone = (name: SubRouterName) => new Hono().route(`/somewhere-else/${name}`, subRouters[name])

const bearer = (token: string | null) => (token ? { Authorization: `Bearer ${token}` } : undefined)

// A path no sub-router serves: the request passes every guard that covers it
// and then answers 404, so no route handler (or anything it would need) runs.
const UNSERVED = '/no-such-route'

// Every route a sub-router registers, with its path parameters filled in.
function routesOf(name: SubRouterName): Array<{ method: string; path: string }> {
  const seen = new Set<string>()
  const routes: Array<{ method: string; path: string }> = []
  for (const route of subRouters[name].routes) {
    if (route.method === 'ALL') continue // the guard itself
    const path = route.path.replace(/:[^/]+/g, 'x').replace(/\/\*$/, '/x')
    const key = `${route.method} ${path}`
    if (seen.has(key)) continue
    seen.add(key)
    routes.push({ method: route.method, path })
  }
  return routes
}

beforeEach(() => {
  validateProxyToken.mockClear()
})

describe('one token lookup per request', () => {
  it.each(names)('/api/x-agent/%s looks the token up once, behind the parent router', async (name) => {
    const res = await asMounted().request(`/api/x-agent/${name}${UNSERVED}`, { method: 'POST', headers: bearer('agent-token') })

    expect(res.status).toBe(404)
    expect(validateProxyToken).toHaveBeenCalledTimes(1)
    expect(validateProxyToken).toHaveBeenCalledWith('agent-token')
  })

  it.each(names)('/api/x-agent/%s looks the token up once when it is mounted ahead of the parent', async (name) => {
    const res = await subRoutersFirst().request(`/api/x-agent/${name}${UNSERVED}`, { method: 'POST', headers: bearer('agent-token') })

    expect(res.status).toBe(404)
    expect(validateProxyToken).toHaveBeenCalledTimes(1)
  })

  it('looks the token up again for the next request', async () => {
    const app = asMounted()

    await app.request(`/api/x-agent/chat${UNSERVED}`, { method: 'POST', headers: bearer('agent-token') })
    await app.request(`/api/x-agent/chat${UNSERVED}`, { method: 'POST', headers: bearer('agent-token') })

    expect(validateProxyToken).toHaveBeenCalledTimes(2)
  })

  it('a refused token is looked up once and never reaches the sub-router', async () => {
    const res = await asMounted().request(`/api/x-agent/chat${UNSERVED}`, { method: 'POST', headers: bearer('stale') })

    expect(res.status).toBe(401)
    expect(validateProxyToken).toHaveBeenCalledTimes(1)
  })
})

describe('every sub-router guards itself', () => {
  it.each(names)('%s has routes to guard', (name) => {
    expect(routesOf(name).length).toBeGreaterThan(0)
  })

  it.each(names)('%s refuses each of its routes without a valid token, mounted without the parent', async (name) => {
    const app = alone(name)
    for (const { method, path } of routesOf(name)) {
      const url = `/somewhere-else/${name}${path === '/' ? '' : path}`
      const missing = await app.request(url, { method })
      expect(missing.status, `${method} ${path} with no token`).toBe(401)
      const stale = await app.request(url, { method, headers: bearer('stale') })
      expect(stale.status, `${method} ${path} with a stale token`).toBe(401)
      const notBearer = await app.request(url, { method, headers: { 'X-Caller-Slug': 'agent', Cookie: 'callerSlug=agent' } })
      expect(notBearer.status, `${method} ${path} with no Authorization header`).toBe(401)
    }
  })

  it.each(names)('%s looks the token up itself when the parent is not in front of it', async (name) => {
    const res = await alone(name).request(`/somewhere-else/${name}${UNSERVED}`, { method: 'POST', headers: bearer('agent-token') })

    expect(res.status).toBe(404)
    expect(validateProxyToken).toHaveBeenCalledTimes(1)
  })

  it.each(names)('%s refuses a missing or stale token behind the parent too', async (name) => {
    const app = asMounted()
    for (const { method, path } of routesOf(name)) {
      const url = `/api/x-agent/${name}${path === '/' ? '' : path}`
      expect((await app.request(url, { method })).status, `${method} ${path} with no token`).toBe(401)
      expect((await app.request(url, { method, headers: bearer('stale') })).status, `${method} ${path} with a stale token`).toBe(401)
    }
  })
})

describe('requireAgentCaller', () => {
  const whoAmI = () => new Hono<{ Variables: { callerSlug: string } }>()

  it('answers the agent the token belongs to', async () => {
    const app = whoAmI().use('*', requireAgentCaller).get('/', c => c.json({ caller: c.get('callerSlug') }))

    expect(await (await app.request('/', { headers: bearer('agent-token') })).json()).toEqual({ caller: 'agent' })
    expect(await (await app.request('/', { headers: bearer('other-token') })).json()).toEqual({ caller: 'other' })
  })

  it('does not take a caller another middleware left on the context for a validated one', async () => {
    const app = whoAmI()
      .use('*', async (c, next) => { c.set('callerSlug', 'victim'); await next() })
      .use('*', requireAgentCaller)
      .get('/', c => c.json({ caller: c.get('callerSlug') }))

    expect((await app.request('/')).status).toBe(401)
    expect((await app.request('/', { headers: bearer('stale') })).status).toBe(401)
    const res = await app.request('/', { headers: bearer('agent-token') })
    expect(await res.json()).toEqual({ caller: 'agent' })
    expect(validateProxyToken).toHaveBeenCalledTimes(2)
  })

  it('looks a token up again when the request no longer carries the one it validated', async () => {
    // Two passes over one request object whose Authorization header changes in
    // between: the answer recorded for the first token is not reused.
    const headers = new Headers(bearer('agent-token'))
    const request = new Request('http://host/', { headers })
    const seen: string[] = []
    const app = whoAmI()
      .use('*', requireAgentCaller)
      .use('*', async (c, next) => {
        seen.push(c.get('callerSlug'))
        c.req.raw.headers.set('Authorization', 'Bearer other-token')
        await next()
      })
      .use('*', requireAgentCaller)
      .get('/', c => c.json({ caller: c.get('callerSlug') }))

    const res = await app.fetch(request)

    expect(seen).toEqual(['agent'])
    expect(await res.json()).toEqual({ caller: 'other' })
    expect(validateProxyToken.mock.calls).toEqual([['agent-token'], ['other-token']])
  })
})

// Set fixed secret BEFORE any imports that call getOrCreateAuthSecret()
process.env.BETTER_AUTH_SECRET = 'tg-dash-test-secret'

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { TelegramDashboardSession, shouldRunDashboardSession } from './telegram-dashboard'
import { signDashboardCookie, DASHBOARD_COOKIE_NAME } from '@shared/lib/telegram/dashboard-cookie'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'

function makeAgentApp() {
  const app = new Hono()
  app.use('/api/agents/:id/*', TelegramDashboardSession())
  app.get('/api/agents/:id/ping', (c) => c.json({ user: (c.get as any)('user') ?? null }))
  return app
}

function makeLlmApp() {
  const app = new Hono()
  app.use('/api/llm/*', TelegramDashboardSession())
  app.get('/api/llm/ping', (c) => c.json({ user: (c.get as any)('user') ?? null }))
  return app
}

describe('TelegramDashboardSession', () => {
  it('sets user when valid cookie and route agent matches cookie agent', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900
    const token = await signDashboardCookie(
      { userId: 'u1', agentSlug: 'sales', dashboardSlug: 'weekly-report', integrationId: 'int1', exp },
      getOrCreateAuthSecret(),
    )
    const res = await makeAgentApp().request('/api/agents/sales/ping', {
      headers: { cookie: `${DASHBOARD_COOKIE_NAME}=${token}` },
    })
    const body = await res.json()
    expect(body.user?.id).toBe('u1')
  })

  it('does not set user when cookie agent differs from route agent', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900
    const token = await signDashboardCookie(
      { userId: 'u1', agentSlug: 'other', dashboardSlug: 'weekly-report', integrationId: 'int1', exp },
      getOrCreateAuthSecret(),
    )
    const res = await makeAgentApp().request('/api/agents/sales/ping', {
      headers: { cookie: `${DASHBOARD_COOKIE_NAME}=${token}` },
    })
    const body = await res.json()
    expect(body.user).toBeNull()
  })

  it('sets user when route has no :id param (llm/stt path) and cookie is valid', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900
    const token = await signDashboardCookie(
      { userId: 'u1', agentSlug: 'sales', dashboardSlug: 'weekly-report', integrationId: 'int1', exp },
      getOrCreateAuthSecret(),
    )
    const res = await makeLlmApp().request('/api/llm/ping', {
      headers: { cookie: `${DASHBOARD_COOKIE_NAME}=${token}` },
    })
    const body = await res.json()
    expect(body.user?.id).toBe('u1')
  })

  it('does not set user when no cookie is present', async () => {
    const res = await makeAgentApp().request('/api/agents/sales/ping')
    const body = await res.json()
    expect(body.user).toBeNull()
  })
})

describe('TelegramDashboardSession — mount scope (artifacts)', () => {
  // Mirrors the production mount in src/api/index.ts: the cookie applies to
  // :artifactSlug/* content reads only, NOT the bare :artifactSlug path (which
  // carries the AgentAdmin-guarded DELETE/PATCH management endpoints). Hono 4's
  // /* also matches the bare path, so the mount delegates to the REAL guard
  // (shouldRunDashboardSession) — tested here, not a re-implemented copy.
  function makeArtifactApp() {
    const app = new Hono()
    const dashboardSession = TelegramDashboardSession()
    app.use('/api/agents/:id/artifacts/:artifactSlug/*', async (c, next) => {
      if (!shouldRunDashboardSession(c)) return next()
      return dashboardSession(c, next)
    })
    app.all('/api/agents/:id/artifacts/:artifactSlug/*', (c) =>
      c.json({ user: (c.get as any)('user') ?? null }),
    )
    app.delete('/api/agents/:id/artifacts/:artifactSlug', (c) =>
      c.json({ user: (c.get as any)('user') ?? null }),
    )
    app.patch('/api/agents/:id/artifacts/:artifactSlug', (c) =>
      c.json({ user: (c.get as any)('user') ?? null }),
    )
    return app
  }

  function makeCookie(dashboardSlug = 'weekly-report') {
    const exp = Math.floor(Date.now() / 1000) + 900
    return signDashboardCookie(
      { userId: 'u1', agentSlug: 'sales', dashboardSlug, integrationId: 'int1', exp },
      getOrCreateAuthSecret(),
    )
  }

  it('sets user on GET /…/artifacts/weekly-report/ (trailing-slash root)', async () => {
    const token = await makeCookie()
    const res = await makeArtifactApp().request(
      '/api/agents/sales/artifacts/weekly-report/',
      { headers: { cookie: `${DASHBOARD_COOKIE_NAME}=${token}` } },
    )
    const body = await res.json()
    expect(body.user?.id).toBe('u1')
  })

  it('sets user on POST to a content sub-path (dashboard backend write — in-app parity)', async () => {
    // The cookie authorizes writes to the dashboard's own (container-sandboxed)
    // backend, matching what an in-app AgentRead viewer can do.
    const token = await makeCookie()
    const res = await makeArtifactApp().request(
      '/api/agents/sales/artifacts/weekly-report/api/save',
      { method: 'POST', headers: { cookie: `${DASHBOARD_COOKIE_NAME}=${token}` } },
    )
    const body = await res.json()
    expect(body.user?.id).toBe('u1')
  })

  it('does NOT set user on DELETE /…/artifacts/weekly-report (bare management path)', async () => {
    const token = await makeCookie()
    const res = await makeArtifactApp().request(
      '/api/agents/sales/artifacts/weekly-report',
      { method: 'DELETE', headers: { cookie: `${DASHBOARD_COOKIE_NAME}=${token}` } },
    )
    const body = await res.json()
    expect(body.user).toBeNull()
  })

  it('does NOT set user on a %2F-encoded bare DELETE (encoding evasion)', async () => {
    // Hono keeps %2F in c.req.path but decodes c.req.param(); a raw-path compare
    // would miss this and let the cookie authorize the destructive bare route.
    const token = await makeCookie()
    for (const slug of ['weekly-report%2F', 'weekly-report%2f', 'weekly%2Freport']) {
      const res = await makeArtifactApp().request(
        `/api/agents/sales/artifacts/${slug}`,
        { method: 'DELETE', headers: { cookie: `${DASHBOARD_COOKIE_NAME}=${token}` } },
      )
      const body = await res.json()
      expect(body.user, `slug=${slug}`).toBeNull()
    }
  })

  it('does NOT set user on a GET to the bare management path (no sub-resource)', async () => {
    const token = await makeCookie()
    const res = await makeArtifactApp().request(
      '/api/agents/sales/artifacts/weekly-report',
      { headers: { cookie: `${DASHBOARD_COOKIE_NAME}=${token}` } },
    )
    const body = await res.json()
    expect(body.user).toBeNull()
  })

  it('does NOT set user when the cookie is scoped to a different dashboard', async () => {
    // Cookie minted for weekly-report must not authorize reads of another
    // dashboard under the same agent.
    const token = await makeCookie('weekly-report')
    const res = await makeArtifactApp().request(
      '/api/agents/sales/artifacts/secret-finances/',
      { headers: { cookie: `${DASHBOARD_COOKIE_NAME}=${token}` } },
    )
    const body = await res.json()
    expect(body.user).toBeNull()
  })
})

describe('shouldRunDashboardSession (unit)', () => {
  // Drive the real predicate through a tiny app so c.req.param/path/method are
  // populated by Hono exactly as in production.
  async function probe(method: string, path: string): Promise<boolean> {
    const app = new Hono()
    app.use('/api/agents/:id/artifacts/:artifactSlug/*', async (c) =>
      c.json({ run: shouldRunDashboardSession(c) }),
    )
    app.use('/api/llm/*', async (c) => c.json({ run: shouldRunDashboardSession(c) }))
    const res = await app.request(path, { method })
    const body = (await res.json()) as { run: boolean }
    return body.run
  }

  it('runs for GET content reads', async () => {
    expect(await probe('GET', '/api/agents/sales/artifacts/weekly-report/index.html')).toBe(true)
  })
  it('runs for llm routes (no :artifactSlug to scope)', async () => {
    expect(await probe('GET', '/api/llm/anthropic')).toBe(true)
  })
  it('runs for mutating methods on a content sub-path (dashboard backend writes)', async () => {
    // Parity with the in-app AgentRead viewer: the cookie authorizes writes to the
    // dashboard's own backend (container-sandboxed), not just reads.
    expect(await probe('POST', '/api/agents/sales/artifacts/weekly-report/api/save')).toBe(true)
    expect(await probe('DELETE', '/api/agents/sales/artifacts/weekly-report/api/item/5')).toBe(true)
    expect(await probe('PATCH', '/api/agents/sales/artifacts/weekly-report/x')).toBe(true)
  })
  it('does not run on the bare management path for ANY method (decoded compare)', async () => {
    // The AgentAdmin DELETE/PATCH management endpoints live on the bare path and
    // must stay off-limits to the cookie regardless of method — with the read-only
    // method gate removed, this decoded-path exclusion is now their SOLE guard.
    for (const m of ['GET', 'DELETE', 'PATCH', 'POST']) {
      expect(await probe(m, '/api/agents/sales/artifacts/weekly-report'), m).toBe(false)
      expect(await probe(m, '/api/agents/sales/artifacts/weekly-report%2F'), m).toBe(false)
    }
  })
})

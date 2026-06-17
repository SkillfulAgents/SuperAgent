// Set fixed secret BEFORE any imports that call getOrCreateAuthSecret()
process.env.BETTER_AUTH_SECRET = 'tg-dash-test-secret'

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { TelegramDashboardSession } from './telegram-dashboard'
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
    const token = signDashboardCookie(
      { userId: 'u1', agentSlug: 'sales', integrationId: 'int1', exp },
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
    const token = signDashboardCookie(
      { userId: 'u1', agentSlug: 'other', integrationId: 'int1', exp },
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
    const token = signDashboardCookie(
      { userId: 'u1', agentSlug: 'sales', integrationId: 'int1', exp },
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

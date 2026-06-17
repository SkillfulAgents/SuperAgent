// Set BETTER_AUTH_SECRET before any imports so getOrCreateAuthSecret() picks it up
process.env.BETTER_AUTH_SECRET = 'tg-dash-test-secret'

import { describe, it, expect, vi } from 'vitest'
import crypto from 'node:crypto'

// ============================================================================
// Mocks — declared before module import
// ============================================================================

// vi.mock factories are hoisted above const declarations — use vi.hoisted for shared literals
const { BOT_TOKEN } = vi.hoisted(() => ({ BOT_TOKEN: '123456:TEST' }))

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  getChatIntegration: vi.fn().mockReturnValue({
    id: 'int1',
    agentSlug: 'sales',
    provider: 'telegram',
    config: JSON.stringify({ botToken: BOT_TOKEN }),
    createdByUserId: 'u1',
    name: null,
    status: 'active',
    showToolCalls: false,
    sessionTimeout: null,
    model: null,
    effort: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
}))

vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  getChatIntegrationSession: vi.fn((integrationId: string, externalChatId: string) => {
    if (integrationId === 'int1' && externalChatId === '42') {
      return { id: 'sess1', integrationId: 'int1', externalChatId: '42' }
    }
    return null
  }),
}))

vi.mock('@shared/lib/services/artifact-service', () => ({
  listArtifactsFromFilesystem: vi.fn().mockResolvedValue([
    { slug: 'weekly-report', name: 'Weekly', description: '', status: 'running', port: 0 },
  ]),
}))

// Import the router AFTER mocks are declared
import app from './telegram-miniapp'

// ============================================================================
// Helper — produce a correctly-signed Telegram initData string
// ============================================================================

function signInitData(fields: Record<string, string>): string {
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex')
  const params = new URLSearchParams({ ...fields, hash })
  return params.toString()
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /', () => {
  it('returns 200 HTML shell referencing the SDK, session endpoint, and an iframe', async () => {
    const res = await app.request('/', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('telegram-web-app.js')
    expect(body).toContain('/api/telegram-miniapp/session')
    expect(body).toContain('<iframe')
  })
})

describe('POST /session', () => {
  it('returns 200 and sets tg_dash cookie for a valid, bound user', async () => {
    const authDate = Math.floor(Date.now() / 1000)
    const initData = signInitData({
      auth_date: String(authDate),
      user: JSON.stringify({ id: 42, username: 'alice' }),
    })

    const res = await app.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initData,
        integrationId: 'int1',
        agentSlug: 'sales',
        dashboardSlug: 'weekly-report',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true })
    expect(body.artifactPath).toBe('/api/agents/sales/artifacts/weekly-report/')
    const setCookieHeader = res.headers.get('set-cookie')
    expect(setCookieHeader).toBeTruthy()
    expect(setCookieHeader).toContain('tg_dash=')
    expect(setCookieHeader).toContain('HttpOnly')
    expect(setCookieHeader).toContain('SameSite=Lax')
    expect(setCookieHeader).toContain('Path=/api')
  })

  it('returns 401 with reason=signature for tampered initData', async () => {
    const authDate = Math.floor(Date.now() / 1000)
    const initData = signInitData({
      auth_date: String(authDate),
      user: JSON.stringify({ id: 42, username: 'alice' }),
    }).replace(/hash=[a-f0-9]+/, 'hash=deadbeef')

    const res = await app.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initData,
        integrationId: 'int1',
        agentSlug: 'sales',
        dashboardSlug: 'weekly-report',
      }),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toMatchObject({ ok: false, reason: 'signature' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 403 with reason=not_bound for a valid signature but unbound user', async () => {
    const authDate = Math.floor(Date.now() / 1000)
    const initData = signInitData({
      auth_date: String(authDate),
      user: JSON.stringify({ id: 999, username: 'stranger' }),
    })

    const res = await app.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initData,
        integrationId: 'int1',
        agentSlug: 'sales',
        dashboardSlug: 'weekly-report',
      }),
    })

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toMatchObject({ ok: false, reason: 'not_bound' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

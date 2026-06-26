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

vi.mock('@shared/lib/platform-auth/config', async (orig) => ({
  ...(await orig()),
  getPlatformBaseUrl: vi.fn(() => 'https://host.example'),
}))

// Import the router AFTER mocks are declared
import app from './telegram-miniapp'
import { signDashboardCookie, DASHBOARD_COOKIE_NAME, DASHBOARD_COOKIE_TTL_SECONDS } from '@shared/lib/telegram/dashboard-cookie'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'
import { getPlatformBaseUrl } from '@shared/lib/platform-auth/config'
import { getChatIntegration } from '@shared/lib/services/chat-integration-service'

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
    // No x-forwarded-proto → http → must NOT set Secure
    expect(setCookieHeader).not.toContain('Secure')
  })

  it('sets Secure on the tg_dash cookie when x-forwarded-proto is https', async () => {
    const authDate = Math.floor(Date.now() / 1000)
    const initData = signInitData({
      auth_date: String(authDate),
      user: JSON.stringify({ id: 42, username: 'alice' }),
    })

    const res = await app.request('/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({
        initData,
        integrationId: 'int1',
        agentSlug: 'sales',
        dashboardSlug: 'weekly-report',
      }),
    })

    expect(res.status).toBe(200)
    const setCookieHeader = res.headers.get('set-cookie')
    expect(setCookieHeader).toBeTruthy()
    expect(setCookieHeader).toContain('Secure')
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

// Full integration row so per-test overrides stay terse and type-safe.
type MiniAppIntegration = NonNullable<ReturnType<typeof getChatIntegration>>
function integrationFixture(overrides: Partial<MiniAppIntegration> = {}): MiniAppIntegration {
  return {
    id: 'int1',
    agentSlug: 'sales',
    provider: 'telegram',
    config: JSON.stringify({ botToken: BOT_TOKEN }),
    createdByUserId: 'u1',
    name: null,
    status: 'active',
    showToolCalls: false,
    requireApproval: false,
    sessionTimeout: null,
    model: null,
    effort: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function postSession(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.request('/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

// Characterization tests for the /session rejection gates (steps 1–10). These lock in the
// authorization branches the e2e header points here for, and assert no tg_dash cookie ever
// leaks on a reject path.
describe('POST /session — rejection branches', () => {
  const boundInitData = () =>
    signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42, username: 'alice' }),
    })

  it('returns 400 bad_request for a non-JSON body', async () => {
    const res = await app.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'bad_request' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 404 not_found when the integration does not exist', async () => {
    vi.mocked(getChatIntegration).mockReturnValueOnce(null)
    const res = await postSession({
      initData: 'stub', integrationId: 'missing', agentSlug: 'sales', dashboardSlug: 'weekly-report',
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'not_found' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 400 not_telegram for a non-telegram integration', async () => {
    vi.mocked(getChatIntegration).mockReturnValueOnce(integrationFixture({ provider: 'slack' }))
    const res = await postSession({
      initData: 'stub', integrationId: 'int1', agentSlug: 'sales', dashboardSlug: 'weekly-report',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'not_telegram' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 400 bad_integration when the telegram config carries no bot token', async () => {
    vi.mocked(getChatIntegration).mockReturnValueOnce(integrationFixture({ config: JSON.stringify({}) }))
    const res = await postSession({
      initData: 'stub', integrationId: 'int1', agentSlug: 'sales', dashboardSlug: 'weekly-report',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'bad_integration' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 403 not_bound when a valid signature carries no user id', async () => {
    // Signature valid but initData has no `user` object → step 6 (tgUserId === undefined),
    // distinct from the step-7 unbound-user case above.
    const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)) })
    const res = await postSession({
      initData, integrationId: 'int1', agentSlug: 'sales', dashboardSlug: 'weekly-report',
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'not_bound' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 400 agent_mismatch when the body agentSlug differs from the integration', async () => {
    const res = await postSession({
      initData: boundInitData(), integrationId: 'int1', agentSlug: 'marketing', dashboardSlug: 'weekly-report',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'agent_mismatch' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 404 dashboard_not_found when the dashboard does not belong to the agent', async () => {
    const res = await postSession({
      initData: boundInitData(), integrationId: 'int1', agentSlug: 'sales', dashboardSlug: 'no-such-dashboard',
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'dashboard_not_found' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 401 no_owner when the integration has no owner to act on behalf of', async () => {
    vi.mocked(getChatIntegration).mockReturnValueOnce(integrationFixture({ createdByUserId: null }))
    const res = await postSession({
      initData: boundInitData(), integrationId: 'int1', agentSlug: 'sales', dashboardSlug: 'weekly-report',
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'no_owner' })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('bounds the minted cookie lifetime with Max-Age', async () => {
    const res = await postSession({
      initData: boundInitData(), integrationId: 'int1', agentSlug: 'sales', dashboardSlug: 'weekly-report',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain(`Max-Age=${DASHBOARD_COOKIE_TTL_SECONDS}`)
  })
})

describe('POST /browser-link', () => {
  it('returns 200 with a url containing the browser endpoint and token (scope rides the signed token, no d param)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const cookieValue = await signDashboardCookie(
      { userId: 'u1', agentSlug: 'sales', dashboardSlug: 'weekly-report', integrationId: 'int1', exp: now + 900 },
      getOrCreateAuthSecret(),
    )

    const res = await app.request('/browser-link', {
      method: 'POST',
      headers: { Cookie: `${DASHBOARD_COOKIE_NAME}=${cookieValue}` },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.url).toContain('/api/telegram-miniapp/browser?token=')
    // The dashboard is bound to the signed token; the slug is no longer a query param.
    expect(body.url).not.toContain('d=')
  })

  it('returns 401 when no tg_dash cookie is present', async () => {
    const res = await app.request('/browser-link', { method: 'POST' })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toMatchObject({ ok: false })
  })

  it('returns 400 no_public_url when no public base URL is configured', async () => {
    const now = Math.floor(Date.now() / 1000)
    const cookieValue = await signDashboardCookie(
      { userId: 'u1', agentSlug: 'sales', dashboardSlug: 'weekly-report', integrationId: 'int1', exp: now + 900 },
      getOrCreateAuthSecret(),
    )
    vi.mocked(getPlatformBaseUrl).mockReturnValueOnce('')

    const res = await app.request('/browser-link', {
      method: 'POST',
      headers: { Cookie: `${DASHBOARD_COOKIE_NAME}=${cookieValue}` },
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'no_public_url' })
  })
})

describe('GET /browser', () => {
  it('returns 200 HTML with Set-Cookie, iframe, and artifact path from the token scope', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await signDashboardCookie(
      { userId: 'u1', agentSlug: 'sales', dashboardSlug: 'weekly-report', integrationId: 'int1', exp: now + 120 },
      getOrCreateAuthSecret(),
    )

    const res = await app.request(`/browser?token=${encodeURIComponent(token)}`, {
      method: 'GET',
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const setCookieHeader = res.headers.get('set-cookie')
    expect(setCookieHeader).toBeTruthy()
    expect(setCookieHeader).toContain('tg_dash=')
    const body = await res.text()
    // Artifact path is built from the signed token's dashboardSlug, not a query param.
    expect(body).toContain('/api/agents/sales/artifacts/weekly-report/')
    expect(body).toContain('<iframe')
  })

  it('returns 400 when the token query param is missing', async () => {
    const res = await app.request('/browser', { method: 'GET' })
    expect(res.status).toBe(400)
  })

  it('returns 401 HTML with no Set-Cookie for an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 1
    const token = await signDashboardCookie(
      { userId: 'u1', agentSlug: 'sales', dashboardSlug: 'weekly-report', integrationId: 'int1', exp: past },
      getOrCreateAuthSecret(),
    )

    const res = await app.request(`/browser?token=${encodeURIComponent(token)}`, {
      method: 'GET',
    })

    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('serves an access-expiry overlay keyed to the cookie TTL', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await signDashboardCookie(
      { userId: 'u1', agentSlug: 'sales', dashboardSlug: 'weekly-report', integrationId: 'int1', exp: now + 120 },
      getOrCreateAuthSecret(),
    )

    const res = await app.request(`/browser?token=${encodeURIComponent(token)}`, {
      method: 'GET',
    })

    expect(res.status).toBe(200)
    const body = await res.text()
    // The browser cookie cannot self-renew (renewal needs Telegram initData),
    // so an expired session must surface a clear prompt instead of leaving the
    // iframe to fail on a bare 401. The overlay fires at the cookie TTL.
    expect(body).toContain('Your access expired')
    expect(body).toContain('Reopen the dashboard from your Telegram chat')
    expect(body).toContain(String(DASHBOARD_COOKIE_TTL_SECONDS * 1000))
  })
})

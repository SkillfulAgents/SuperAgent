import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'

// ---------------------------------------------------------------------------
// SUP-201 — focused security guardrail for the platform-auth API.
//
// The platform-auth `/complete` and `/revoke` endpoints write/clear a single
// deployment-global `settings.platformAuth` record and ignore the calling user.
// In AUTH_MODE the UI renders these controls read-only ("managed by this
// deployment"), but the API was guarded only by `Authenticated()`, so any
// logged-in user could overwrite or wipe the shared platform identity.
//
// These tests mount the REAL route (with the service layer mocked) and assert
// that, in auth mode, an ordinary user is rejected with a 4xx and the mutating
// service functions are never reached.
// ---------------------------------------------------------------------------

const {
  mockSavePlatformAuth,
  mockRevokePlatformToken,
  mockGetPlatformAuthStatus,
  mockIsAuthMode,
} = vi.hoisted(() => ({
  mockSavePlatformAuth: vi.fn(),
  mockRevokePlatformToken: vi.fn(),
  mockGetPlatformAuthStatus: vi.fn(),
  mockIsAuthMode: vi.fn<() => boolean>(),
}))

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

// `Authenticated()` — simulate a successfully logged-in ordinary (non-admin)
// user, matching the repro ("authenticate as any normal user"). Mocked so the
// test doesn't pull in better-auth / db.
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (c: Context, next: Next) => {
    c.set('user' as never, { id: 'ordinary-user', role: 'user' } as never)
    return next()
  },
}))

vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: () => 'ordinary-user',
}))

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  savePlatformAuth: (...args: unknown[]) => mockSavePlatformAuth(...args),
  revokePlatformToken: (...args: unknown[]) => mockRevokePlatformToken(...args),
  getPlatformAuthStatus: (...args: unknown[]) => mockGetPlatformAuthStatus(...args),
}))

vi.mock('@shared/lib/services/platform-service', () => ({
  platformService: {
    refreshBilling: vi.fn(),
    getCachedBilling: vi.fn(),
    getLastRefreshedAt: vi.fn(),
  },
}))

vi.mock('@shared/lib/services/platform-device-service', () => ({
  getOrCreatePlatformClientInstanceId: () => 'client-instance',
  getPlatformDeviceName: () => 'device',
}))

vi.mock('@shared/lib/platform-auth/config', () => ({
  buildPlatformLoginUrl: () => 'https://example.test/login',
  getPlatformBaseUrl: () => 'https://example.test',
}))

vi.mock('@shared/lib/platform-auth/platform-fetch', () => ({
  PlatformRequestError: class PlatformRequestError extends Error {
    status: number
    constructor(message: string, status = 400) {
      super(message)
      this.status = status
    }
  },
}))

vi.mock('@shared/lib/error-reporting', () => ({
  setErrorReportingUser: vi.fn(),
  captureException: vi.fn(),
}))

// Import the real route AFTER the mocks are registered.
import platformAuthRoute from './platform-auth'

function appWithPlatformAuth() {
  const app = new Hono()
  app.route('/api/platform-auth', platformAuthRoute)
  return app
}

function expectClientError(status: number) {
  expect(status, `expected a 4xx client error, got ${status}`).toBeGreaterThanOrEqual(400)
  expect(status, `expected a 4xx client error, got ${status}`).toBeLessThan(500)
}

describe('platform auth: deployment-global mutation guard (SUP-201)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Auth mode on, no env-managed PLATFORM_TOKEN — the deployment-global
    // settings record is what would be written.
    mockIsAuthMode.mockReturnValue(true)
    delete process.env.PLATFORM_TOKEN
    mockSavePlatformAuth.mockResolvedValue({ connected: true, tokenPreview: 'plat_…', email: null })
    mockRevokePlatformToken.mockResolvedValue(true)
    mockGetPlatformAuthStatus.mockReturnValue({ connected: false })
  })

  it('rejects changing deployment-global platform auth in auth mode without an env token', async () => {
    const res = await appWithPlatformAuth().request('http://localhost/api/platform-auth/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'plat_attacker_token_1234567890abcdef',
        orgId: 'attacker-org',
        userId: 'attacker-platform-user',
        memberId: 'attacker-member',
      }),
    })

    expectClientError(res.status)
    expect(mockSavePlatformAuth).not.toHaveBeenCalled()
  })

  it('rejects revoking deployment-global platform auth in auth mode without an env token', async () => {
    const res = await appWithPlatformAuth().request('http://localhost/api/platform-auth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearLocal: true }),
    })

    expectClientError(res.status)
    expect(mockRevokePlatformToken).not.toHaveBeenCalled()
  })

  // Guard must not regress local/Electron (non-auth) mode, where platform auth
  // is genuinely user-owned and the connect/disconnect flow is expected to work.
  it('still allows platform auth changes when auth mode is disabled', async () => {
    mockIsAuthMode.mockReturnValue(false)

    const complete = await appWithPlatformAuth().request('http://localhost/api/platform-auth/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'plat_local_token_1234567890', orgId: 'my-org' }),
    })
    expect(complete.status).toBe(200)
    expect(mockSavePlatformAuth).toHaveBeenCalledOnce()

    const revoke = await appWithPlatformAuth().request('http://localhost/api/platform-auth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearLocal: true }),
    })
    expect(revoke.status).toBe(200)
    expect(mockRevokePlatformToken).toHaveBeenCalledOnce()
  })
})

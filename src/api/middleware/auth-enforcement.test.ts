import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono, type Context } from 'hono'
import { appState, closeAppState, digestKeyPart } from '@shared/lib/app-state'
import { defineLockout } from '@shared/lib/app-state/lockout'

// Mock getSettings to return configurable auth settings
let mockAuthSettings: Record<string, unknown> = {}
let mockUserCount = 1 // Default: at least one user exists (not first user)
let mockInvited: { status: string } | undefined // the user row an email sign-up names, if any
// Claiming the account is covered against the real Better Auth (invited-user-claim.integration.test.ts).
const signUpInvitedUser = vi.hoisted(() => vi.fn(async (c: Context) => c.json({ claimed: true })))
vi.mock('./invited-sign-up', () => ({ signUpInvitedUser }))

vi.mock('@shared/lib/config/settings', () => ({
  DEFAULT_AUTH_SETTINGS: {
    signupMode: 'invitation_only',
    allowedSignupDomains: [],
    requireAdminApproval: true,
    defaultUserRole: 'member',
    allowLocalAuth: true,
    allowSocialAuth: false,
    passwordMinLength: 12,
    passwordMaxLength: 128,
    passwordRequireComplexity: true,
    sessionMaxLifetimeHrs: 24,
    sessionIdleTimeoutMin: 60,
    maxConcurrentSessions: 5,
    accountLockoutThreshold: 10,
    accountLockoutDurationMin: 30,
  },
  getSettings: () => ({ auth: mockAuthSettings }),
}))

// Mock DB for first-user check
vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        get: () => ({ count: mockUserCount }),
        where: () => ({ get: () => mockInvited }),
      }),
    }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  user: {},
}))

vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray) => strings.join(''),
}))

import { authEnforcementMiddleware, validatePasswordComplexity } from './auth-enforcement'

function createApp() {
  const app = new Hono()
  app.use('/api/auth/*', authEnforcementMiddleware)
  // Mock Better Auth handler — just returns 200 with { ok: true }
  app.post('/api/auth/*', (c) => c.json({ ok: true }))
  app.get('/api/auth/*', (c) => c.json({ ok: true }))
  return app
}

function postJson(app: Hono, path: string, body: Record<string, unknown>) {
  return app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('auth enforcement middleware', () => {
  beforeEach(() => {
    mockAuthSettings = {}
    mockUserCount = 1 // default: not first user
    mockInvited = undefined
    signUpInvitedUser.mockClear()
    // Lockouts live in AppState, which the shared setup installs fresh for every test.
  })

  // ── Signup Mode ──────────────────────────────────────────────────────

  describe('signup mode', () => {
    it('lets someone invited from a team directory sign up while sign-ups are invitation-only, into the account waiting for them', async () => {
      mockAuthSettings = { signupMode: 'invitation_only' }
      mockInvited = { status: 'invited' }
      const res = await postJson(createApp(), '/api/auth/sign-up/email', { email: 'Dana@acme.test', password: 'StrongPass123!', name: 'Dana' })
      expect(await res.json()).toEqual({ claimed: true })
      expect(signUpInvitedUser).toHaveBeenCalledOnce()
    })

    it('holds an invited sign-up to the password policy, and to closed sign-ups', async () => {
      mockInvited = { status: 'invited' }
      mockAuthSettings = { signupMode: 'invitation_only' }
      expect((await postJson(createApp(), '/api/auth/sign-up/email', { email: 'dana@acme.test', password: 'short', name: 'Dana' })).status).toBe(400)
      mockAuthSettings = { signupMode: 'closed' }
      expect((await postJson(createApp(), '/api/auth/sign-up/email', { email: 'dana@acme.test', password: 'StrongPass123!', name: 'Dana' })).status).toBe(403)
      expect(signUpInvitedUser).not.toHaveBeenCalled()
    })

    it('blocks signup when mode is closed', async () => {
      mockAuthSettings = { signupMode: 'closed' }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'Test1234!',
        name: 'Test',
      })
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data.code).toBe('SIGNUPS_DISABLED')
    })

    it('blocks signup when mode is invitation_only', async () => {
      mockAuthSettings = { signupMode: 'invitation_only' }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'Test1234!',
        name: 'Test',
      })
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('SIGNUPS_DISABLED')
    })

    it('allows signup when mode is open', async () => {
      mockAuthSettings = { signupMode: 'open', passwordMinLength: 8, passwordRequireComplexity: false }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'password123',
        name: 'Test',
      })
      expect(res.status).toBe(200)
    })

    it('blocks signup from wrong domain when domain_restricted', async () => {
      mockAuthSettings = {
        signupMode: 'domain_restricted',
        allowedSignupDomains: ['allowed.com'],
        passwordMinLength: 8,
        passwordRequireComplexity: false,
      }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@other.com',
        password: 'password123',
        name: 'Test',
      })
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('DOMAIN_NOT_ALLOWED')
    })

    it('allows signup from correct domain when domain_restricted', async () => {
      mockAuthSettings = {
        signupMode: 'domain_restricted',
        allowedSignupDomains: ['allowed.com'],
        passwordMinLength: 8,
        passwordRequireComplexity: false,
      }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@allowed.com',
        password: 'password123',
        name: 'Test',
      })
      expect(res.status).toBe(200)
    })

    it('allows first user to sign up regardless of signup mode', async () => {
      mockAuthSettings = { signupMode: 'closed' }
      mockUserCount = 0 // no users yet
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'first@example.com',
        password: 'password123',
        name: 'First User',
      })
      expect(res.status).toBe(200)
    })

    it('does not let a first user sign up by email on a platform-controlled deployment', async () => {
      vi.stubEnv('AUTH_MODE', 'true')
      vi.stubEnv('PLATFORM_TOKEN', `e30.${Buffer.from(JSON.stringify({ orgId: 'org_1' })).toString('base64url')}.sig`)
      try {
        mockUserCount = 0
        const res = await postJson(createApp(), '/api/auth/sign-up/email', {
          email: 'stranger@example.com',
          password: 'password123',
          name: 'Stranger',
        })
        expect(res.status).toBe(403)
        expect(await res.json()).toMatchObject({ code: 'SIGNUPS_DISABLED' })
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it('domain matching is case-insensitive', async () => {
      mockAuthSettings = {
        signupMode: 'domain_restricted',
        allowedSignupDomains: ['Allowed.COM'],
        passwordMinLength: 8,
        passwordRequireComplexity: false,
      }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@allowed.com',
        password: 'password123',
        name: 'Test',
      })
      expect(res.status).toBe(200)
    })
  })

  // ── Local Auth ───────────────────────────────────────────────────────

  describe('allow local auth', () => {
    it('blocks signup when local auth disabled', async () => {
      mockAuthSettings = { signupMode: 'open', passwordMinLength: 8, allowLocalAuth: false }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'Test1234!',
        name: 'Test',
      })
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('LOCAL_AUTH_DISABLED')
    })

    it('blocks sign-in when local auth disabled', async () => {
      mockAuthSettings = { allowLocalAuth: false }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-in/email', {
        email: 'test@example.com',
        password: 'password123',
      })
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('LOCAL_AUTH_DISABLED')
    })
  })

  // ── Password Min Length ─────────────────────────────────────────────

  describe('password min length', () => {
    it('blocks signup with password shorter than minimum', async () => {
      mockAuthSettings = { signupMode: 'open', passwordMinLength: 16, passwordRequireComplexity: false }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'short',
        name: 'Test',
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.code).toBe('WEAK_PASSWORD')
      expect(data.message).toContain('16')
    })

    it('allows signup with password at minimum length', async () => {
      mockAuthSettings = { signupMode: 'open', passwordMinLength: 8, passwordRequireComplexity: false }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'exactly8',
        name: 'Test',
      })
      expect(res.status).toBe(200)
    })

    it('blocks change-password with password shorter than minimum', async () => {
      mockAuthSettings = { passwordMinLength: 20, passwordRequireComplexity: false }
      const app = createApp()
      const res = await postJson(app, '/api/auth/change-password', {
        currentPassword: 'old',
        newPassword: 'tooshort',
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.code).toBe('WEAK_PASSWORD')
      expect(data.message).toContain('20')
    })

    it('checks min length before complexity', async () => {
      mockAuthSettings = { signupMode: 'open', passwordMinLength: 20, passwordRequireComplexity: true }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'Sh0rt!',
        name: 'Test',
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      // Should fail on length, not complexity
      expect(data.message).toContain('20')
    })

    it('uses default min length (12) when not configured', async () => {
      mockAuthSettings = { signupMode: 'open', passwordRequireComplexity: false }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'short',
        name: 'Test',
      })
      expect(res.status).toBe(400)
      expect((await res.json()).message).toContain('12')
    })
  })

  // ── Password Complexity ──────────────────────────────────────────────

  describe('password complexity', () => {
    it('blocks signup with password missing uppercase', async () => {
      mockAuthSettings = { signupMode: 'open', passwordMinLength: 8, passwordRequireComplexity: true }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'lowercase1234!',
        name: 'Test',
      })
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('WEAK_PASSWORD')
    })

    it('blocks signup with password missing number', async () => {
      mockAuthSettings = { signupMode: 'open', passwordMinLength: 8, passwordRequireComplexity: true }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'NoNumbers!Here',
        name: 'Test',
      })
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('WEAK_PASSWORD')
    })

    it('blocks signup with password missing symbol', async () => {
      mockAuthSettings = { signupMode: 'open', passwordMinLength: 8, passwordRequireComplexity: true }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'NoSymbols1234A',
        name: 'Test',
      })
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('WEAK_PASSWORD')
    })

    it('allows signup with strong password', async () => {
      mockAuthSettings = { signupMode: 'open', passwordMinLength: 8, passwordRequireComplexity: true }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'StrongPass1!',
        name: 'Test',
      })
      expect(res.status).toBe(200)
    })

    it('skips complexity check when disabled', async () => {
      mockAuthSettings = { signupMode: 'open', passwordMinLength: 8, passwordRequireComplexity: false }
      const app = createApp()
      const res = await postJson(app, '/api/auth/sign-up/email', {
        email: 'test@example.com',
        password: 'weakpassword',
        name: 'Test',
      })
      expect(res.status).toBe(200)
    })

    it('blocks change-password with weak password', async () => {
      mockAuthSettings = { passwordMinLength: 8, passwordRequireComplexity: true }
      const app = createApp()
      const res = await postJson(app, '/api/auth/change-password', {
        currentPassword: 'old',
        newPassword: 'onlylowercase',
      })
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('WEAK_PASSWORD')
    })

    it('allows change-password with strong password', async () => {
      mockAuthSettings = { passwordMinLength: 8, passwordRequireComplexity: true }
      const app = createApp()
      const res = await postJson(app, '/api/auth/change-password', {
        currentPassword: 'old',
        newPassword: 'StrongNew1!',
      })
      expect(res.status).toBe(200)
    })
  })

  // ── Account Lockout ──────────────────────────────────────────────────

  describe('account lockout', () => {
    it('locks account after threshold failed attempts', async () => {
      mockAuthSettings = { accountLockoutThreshold: 3, accountLockoutDurationMin: 30 }
      // Create app with mock handler that returns 401 (failed login)
      const app = new Hono()
      app.use('/api/auth/*', authEnforcementMiddleware)
      app.post('/api/auth/*', (c) => c.json({ error: 'Invalid credentials' }, 401))

      const body = { email: 'locktest@example.com', password: 'wrong' }

      // First 3 attempts should return 401 (passed through)
      for (let i = 0; i < 3; i++) {
        const res = await postJson(app, '/api/auth/sign-in/email', body)
        expect(res.status).toBe(401)
      }

      // 4th attempt should be locked (429)
      const res = await postJson(app, '/api/auth/sign-in/email', body)
      expect(res.status).toBe(429)
      expect((await res.json()).code).toBe('ACCOUNT_LOCKED')
    })

    it('clears lockout on successful login', async () => {
      mockAuthSettings = { accountLockoutThreshold: 2, accountLockoutDurationMin: 30 }
      let loginSuccess = false

      const app = new Hono()
      app.use('/api/auth/*', authEnforcementMiddleware)
      app.post('/api/auth/*', (c) => {
        if (loginSuccess) return c.json({ ok: true })
        return c.json({ error: 'Invalid' }, 401)
      })

      const body = { email: 'cleartest@example.com', password: 'password' }

      // Fail once
      await postJson(app, '/api/auth/sign-in/email', body)

      // Succeed (should clear lockout)
      loginSuccess = true
      const res = await postJson(app, '/api/auth/sign-in/email', body)
      expect(res.status).toBe(200)

      // Fail again (counter should be reset)
      loginSuccess = false
      const res2 = await postJson(app, '/api/auth/sign-in/email', body)
      expect(res2.status).toBe(401) // not 429
    })

    describe('state in AppState', () => {
      const T0 = Date.parse('2026-11-04T12:00:00Z')
      // The same records the middleware writes: keys are paths, so an equal definition reads them.
      const lockouts = defineLockout({ name: 'auth:lockout' })

      beforeEach(() => {
        mockAuthSettings = { accountLockoutThreshold: 3, accountLockoutDurationMin: 30 }
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(T0)
      })

      afterEach(() => {
        vi.useRealTimers()
      })

      /** Better Auth stand-in: 'right' signs in (after `gate` when one is set), anything else is a 401. */
      function signInApp(gate?: { reached: () => void; release: Promise<void> }) {
        const handler = vi.fn(async (c: Context) => {
          const { password } = await c.req.json()
          if (password !== 'right') return c.json({ error: 'Invalid credentials' }, 401)
          if (gate) {
            gate.reached()
            await gate.release
          }
          return c.json({ ok: true })
        })
        const app = new Hono()
        app.use('/api/auth/*', authEnforcementMiddleware)
        app.post('/api/auth/*', handler)
        return { app, handler }
      }

      const signIn = (app: Hono, password: string, email = 'race@example.com') =>
        postJson(app, '/api/auth/sign-in/email', { email, password })

      it('keys the lockout by the digested lowercase email', async () => {
        const { app } = signInApp()
        await signIn(app, 'wrong', 'Case@Example.com')
        await signIn(app, 'wrong', 'case@example.COM')

        const entry = await appState().get(lockouts.key(digestKeyPart('case@example.com')))
        expect(entry?.value.failures).toBe(2)
      })

      it('counts every competing failed sign-in', async () => {
        const { app, handler } = signInApp()
        const results = await Promise.all([signIn(app, 'wrong'), signIn(app, 'wrong'), signIn(app, 'wrong')])
        expect(results.map((res) => res.status)).toEqual([401, 401, 401])

        const locked = await signIn(app, 'right')
        expect(locked.status).toBe(429)
        expect(handler).toHaveBeenCalledTimes(3)
      })

      it('keeps a wrong password that lands while a sign-in succeeds', async () => {
        let reached!: () => void
        let release!: () => void
        const gate = {
          reached: () => reached(),
          release: new Promise<void>((resolve) => (release = resolve)),
        }
        const atGate = new Promise<void>((resolve) => (reached = resolve))
        const { app } = signInApp(gate)

        expect((await signIn(app, 'wrong')).status).toBe(401)
        // Checked against one failure, then held inside the sign-in.
        const success = signIn(app, 'right')
        await atGate
        expect((await signIn(app, 'wrong')).status).toBe(401)
        release()
        expect((await success).status).toBe(200)

        // The success cleared the failure it was checked against, not the one that landed meanwhile.
        expect((await appState().get(lockouts.key(digestKeyPart('race@example.com'))))?.value.failures).toBe(1)
        expect((await signIn(app, 'wrong')).status).toBe(401)
        expect((await signIn(app, 'wrong')).status).toBe(401)
        expect((await signIn(app, 'wrong')).status).toBe(429)
      })

      it('unlocks once the lock duration has passed, counting from zero', async () => {
        const { app } = signInApp()
        for (let i = 0; i < 3; i++) await signIn(app, 'wrong')

        vi.setSystemTime(T0 + 30 * 60_000 - 1)
        const locked = await signIn(app, 'right')
        expect(locked.status).toBe(429)
        expect((await locked.json()).message).toBe('Account is locked. Try again in 1 minute.')

        vi.setSystemTime(T0 + 30 * 60_000)
        expect((await signIn(app, 'wrong')).status).toBe(401)
        expect((await signIn(app, 'wrong')).status).toBe(401)
        expect((await signIn(app, 'right')).status).toBe(200)
      })

      it('keeps failures below the threshold however long ago they were', async () => {
        const { app } = signInApp()
        await signIn(app, 'wrong')
        await signIn(app, 'wrong')

        vi.setSystemTime(T0 + 365 * 24 * 60 * 60_000)
        await signIn(app, 'wrong')
        expect((await signIn(app, 'right')).status).toBe(429)
      })

      it('refuses the sign-in when the lockout cannot be read', async () => {
        const { app, handler } = signInApp()
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        await closeAppState()

        expect((await signIn(app, 'right')).status).toBe(500)
        expect(handler).not.toHaveBeenCalled()
        expect(String(consoleError.mock.calls[0]?.[0])).toContain('AppState is not initialized')
        consoleError.mockRestore()
      })

      it("keeps Better Auth's answer when the lockout cannot be updated", async () => {
        const { app } = signInApp()
        await signIn(app, 'wrong')
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(appState(), 'compareAndSet').mockRejectedValueOnce(new Error('backend down'))
        vi.spyOn(appState(), 'consume').mockRejectedValueOnce(new Error('backend down'))

        expect((await signIn(app, 'wrong')).status).toBe(401)
        expect((await signIn(app, 'right')).status).toBe(200)
        expect(consoleError).toHaveBeenCalledTimes(2)
        consoleError.mockRestore()
      })
    })
  })

  // ── GET requests pass through ────────────────────────────────────────

  describe('GET requests', () => {
    it('passes GET requests through without enforcement', async () => {
      mockAuthSettings = { signupMode: 'closed' }
      const app = createApp()
      const res = await app.request('http://localhost/api/auth/get-session', { method: 'GET' })
      expect(res.status).toBe(200)
    })
  })

  // ── validatePasswordComplexity unit tests ────────────────────────────

  describe('validatePasswordComplexity', () => {
    it('returns null for valid password', () => {
      expect(validatePasswordComplexity('Abc123!@')).toBeNull()
    })

    it('rejects missing lowercase', () => {
      expect(validatePasswordComplexity('ABC123!@')).not.toBeNull()
    })

    it('rejects missing uppercase', () => {
      expect(validatePasswordComplexity('abc123!@')).not.toBeNull()
    })

    it('rejects missing number', () => {
      expect(validatePasswordComplexity('Abcdef!@')).not.toBeNull()
    })

    it('rejects missing symbol', () => {
      expect(validatePasswordComplexity('Abc12345')).not.toBeNull()
    })
  })
})

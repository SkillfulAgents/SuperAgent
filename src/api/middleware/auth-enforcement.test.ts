import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// Mock getSettings to return configurable auth settings
let mockAuthSettings: Record<string, unknown> = {}
let mockUserCount = 1 // Default: at least one user exists (not first user)

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

import { authEnforcementMiddleware, clearLockouts, validatePasswordComplexity } from './auth-enforcement'

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
    clearLockouts()
  })

  // ── Signup Mode ──────────────────────────────────────────────────────

  describe('signup mode', () => {
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

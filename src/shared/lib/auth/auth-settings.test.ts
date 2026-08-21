import { afterEach, describe, expect, it, vi } from 'vitest'

const mockIsAuthMode = vi.hoisted(() => vi.fn(() => false))
const mockGetSettings = vi.hoisted(() => vi.fn(() => ({ auth: {} as Record<string, unknown> })))

vi.mock('./mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

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
  getSettings: () => mockGetSettings(),
}))

import { getAuthSettings, isPlatformControlledAuth, resolveAuthSettings } from './auth-settings'

function makeOrgToken(orgId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ orgId })}.sig`
}

describe('auth-settings', () => {
  afterEach(() => {
    mockIsAuthMode.mockReturnValue(false)
    mockGetSettings.mockReturnValue({ auth: {} })
    delete process.env.PLATFORM_TOKEN
    delete process.env.AUTH_MODE
  })

  describe('isPlatformControlledAuth', () => {
    it('is true when AUTH_MODE and PLATFORM_TOKEN carries an orgId claim', () => {
      mockIsAuthMode.mockReturnValue(true)
      process.env.PLATFORM_TOKEN = makeOrgToken('org_abc')
      expect(isPlatformControlledAuth()).toBe(true)
    })

    it('is false for an opaque personal PLATFORM_TOKEN', () => {
      mockIsAuthMode.mockReturnValue(true)
      process.env.PLATFORM_TOKEN = 'opaque_personal_access_key'
      expect(isPlatformControlledAuth()).toBe(false)
    })

    it('is false when AUTH_MODE is off', () => {
      mockIsAuthMode.mockReturnValue(false)
      process.env.PLATFORM_TOKEN = makeOrgToken('org_abc')
      expect(isPlatformControlledAuth()).toBe(false)
    })

    it('is false when PLATFORM_TOKEN is absent', () => {
      mockIsAuthMode.mockReturnValue(true)
      expect(isPlatformControlledAuth()).toBe(false)
    })
  })

  describe('resolveAuthSettings', () => {
    it('keeps default requireAdminApproval true for self-hosted AUTH_MODE', () => {
      mockIsAuthMode.mockReturnValue(true)
      expect(resolveAuthSettings({}).requireAdminApproval).toBe(true)
    })

    it('does not force overrides for opaque PLATFORM_TOKEN self-host', () => {
      mockIsAuthMode.mockReturnValue(true)
      process.env.PLATFORM_TOKEN = 'opaque_personal_access_key'
      const resolved = resolveAuthSettings({
        requireAdminApproval: true,
        signupMode: 'open',
      })
      expect(resolved.requireAdminApproval).toBe(true)
      expect(resolved.signupMode).toBe('open')
    })

    it('forces requireAdminApproval false and signupMode closed when platform-controlled', () => {
      mockIsAuthMode.mockReturnValue(true)
      process.env.PLATFORM_TOKEN = makeOrgToken('org_abc')
      const resolved = resolveAuthSettings({
        requireAdminApproval: true,
        signupMode: 'open',
      })
      expect(resolved.requireAdminApproval).toBe(false)
      expect(resolved.signupMode).toBe('closed')
    })

    it('preserves unrelated auth fields when forcing platform overrides', () => {
      mockIsAuthMode.mockReturnValue(true)
      process.env.PLATFORM_TOKEN = makeOrgToken('org_abc')
      const resolved = resolveAuthSettings({
        requireAdminApproval: true,
        allowLocalAuth: false,
        signupMode: 'open',
      })
      expect(resolved).toMatchObject({
        requireAdminApproval: false,
        allowLocalAuth: false,
        signupMode: 'closed',
      })
    })
  })

  describe('getAuthSettings', () => {
    it('reads persisted auth and applies platform-controlled override', () => {
      mockIsAuthMode.mockReturnValue(true)
      process.env.PLATFORM_TOKEN = makeOrgToken('org_abc')
      mockGetSettings.mockReturnValue({
        auth: { requireAdminApproval: true, allowLocalAuth: false, signupMode: 'open' },
      })
      expect(getAuthSettings()).toMatchObject({
        requireAdminApproval: false,
        allowLocalAuth: false,
        signupMode: 'closed',
      })
    })
  })
})

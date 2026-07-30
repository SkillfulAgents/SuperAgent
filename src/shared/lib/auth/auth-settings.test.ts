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

describe('auth-settings', () => {
  afterEach(() => {
    mockIsAuthMode.mockReturnValue(false)
    mockGetSettings.mockReturnValue({ auth: {} })
    delete process.env.PLATFORM_TOKEN
    delete process.env.AUTH_MODE
  })

  describe('isPlatformControlledAuth', () => {
    it('is true only when AUTH_MODE and PLATFORM_TOKEN are both set', () => {
      mockIsAuthMode.mockReturnValue(true)
      process.env.PLATFORM_TOKEN = 'org-jwt'
      expect(isPlatformControlledAuth()).toBe(true)
    })

    it('is false when AUTH_MODE is off', () => {
      mockIsAuthMode.mockReturnValue(false)
      process.env.PLATFORM_TOKEN = 'org-jwt'
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

    it('forces requireAdminApproval false when platform-controlled', () => {
      mockIsAuthMode.mockReturnValue(true)
      process.env.PLATFORM_TOKEN = 'org-jwt'
      expect(resolveAuthSettings({ requireAdminApproval: true }).requireAdminApproval).toBe(false)
    })

    it('preserves other auth fields when forcing approval off', () => {
      mockIsAuthMode.mockReturnValue(true)
      process.env.PLATFORM_TOKEN = 'org-jwt'
      const resolved = resolveAuthSettings({
        requireAdminApproval: true,
        allowLocalAuth: false,
        signupMode: 'closed',
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
      process.env.PLATFORM_TOKEN = 'org-jwt'
      mockGetSettings.mockReturnValue({ auth: { requireAdminApproval: true, allowLocalAuth: false } })
      expect(getAuthSettings()).toMatchObject({
        requireAdminApproval: false,
        allowLocalAuth: false,
      })
    })
  })
})

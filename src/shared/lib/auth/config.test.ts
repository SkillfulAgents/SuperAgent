/**
 * Trusted-origins resolution: the TRUSTED_ORIGINS env var is the documented
 * deployment interface and must win over settings.json — it feeds Better
 * Auth's baseURL and the audience the token-exchange endpoint verifies
 * grants against.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getAppBaseUrl, getCurrentUserId, getTrustedOrigins } from './config'
import type { Context } from 'hono'

const mockSettings = vi.hoisted(() => ({ auth: {} as Record<string, unknown> }))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockSettings,
}))

const mockIsAuthMode = vi.hoisted(() => vi.fn(() => false))
vi.mock('./mode', () => ({ isAuthMode: mockIsAuthMode }))

/** Minimal Context stand-in: getCurrentUserId only reads `c.get('user')`. */
function ctx(user?: { id: string }): Context {
  return { get: (key: string) => (key === 'user' ? user : undefined) } as unknown as Context
}

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ['TRUSTED_ORIGINS', 'HOST', 'PORT', 'USE_HTTPS']) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  mockSettings.auth = {}
  mockIsAuthMode.mockReturnValue(false)
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('getTrustedOrigins', () => {
  it('prefers the TRUSTED_ORIGINS env var over settings', () => {
    process.env.TRUSTED_ORIGINS = 'https://cloud.example, https://second.example'
    mockSettings.auth = { trustedOrigins: ['https://settings.example'] }
    expect(getTrustedOrigins()).toEqual(['https://cloud.example', 'https://second.example'])
  })

  it('falls back to settings when the env var is unset or empty', () => {
    mockSettings.auth = { trustedOrigins: ['https://settings.example'] }
    expect(getTrustedOrigins()).toEqual(['https://settings.example'])
    process.env.TRUSTED_ORIGINS = ' , '
    expect(getTrustedOrigins()).toEqual(['https://settings.example'])
  })
})

describe('getAppBaseUrl', () => {
  it('uses the first TRUSTED_ORIGINS entry (the documented cloud contract)', () => {
    process.env.TRUSTED_ORIGINS = 'https://cloud.example'
    expect(getAppBaseUrl()).toBe('https://cloud.example')
  })

  it('falls back to HOST/PORT/USE_HTTPS when no origins are configured', () => {
    process.env.HOST = 'deploy.example'
    process.env.PORT = '8443'
    process.env.USE_HTTPS = 'true'
    expect(getAppBaseUrl()).toBe('https://deploy.example:8443')
  })

  it('defaults to localhost when nothing is configured', () => {
    expect(getAppBaseUrl()).toBe('http://localhost:47891')
  })
})

/**
 * Per-user features key their rows on this. Outside auth mode there are no
 * user rows at all, so it must still yield a stable id rather than nothing —
 * a caller that treated "no user" as "skip" would silently withdraw the
 * feature from every local install.
 */
describe('getCurrentUserId', () => {
  it('returns the local sentinel outside auth mode, not undefined', () => {
    expect(getCurrentUserId(ctx())).toBe('local')
  })

  it('returns the authenticated user in auth mode', () => {
    mockIsAuthMode.mockReturnValue(true)

    expect(getCurrentUserId(ctx({ id: 'user-42' }))).toBe('user-42')
  })

  it('throws rather than guessing when auth mode has no user in context', () => {
    mockIsAuthMode.mockReturnValue(true)

    expect(() => getCurrentUserId(ctx())).toThrow(/User not found in context/)
  })
})

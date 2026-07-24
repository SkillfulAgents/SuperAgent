/**
 * Trusted-origins resolution: the TRUSTED_ORIGINS env var is the documented
 * deployment interface and must win over settings.json — it feeds Better
 * Auth's baseURL and the audience the token-exchange endpoint verifies
 * grants against.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getAppBaseUrl, getTrustedOrigins } from './config'

const mockSettings = vi.hoisted(() => ({ auth: {} as Record<string, unknown> }))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockSettings,
}))

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ['TRUSTED_ORIGINS', 'HOST', 'PORT', 'USE_HTTPS']) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  mockSettings.auth = {}
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

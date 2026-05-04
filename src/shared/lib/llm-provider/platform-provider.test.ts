import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.test',
}))

const mockGetPlatformAccessToken = vi.fn()
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))

vi.mock('@shared/lib/db', () => {
  const chainable = {
    select: () => chainable,
    from: () => chainable,
    where: () => chainable,
    orderBy: () => chainable,
    limit: () => chainable,
    all: () => [{ accountId: 'sub_alice' }],
  }
  return { db: chainable }
})

vi.mock('@shared/lib/db/schema', () => ({
  authAccount: { userId: 'u', providerId: 'p', accountId: 'a', updatedAt: 't' },
}))

vi.mock('drizzle-orm', () => ({ eq: () => '=', and: () => '&', desc: () => 'DESC' }))

import { runWithRequestUser } from '@shared/lib/platform-attribution'
import { PlatformLlmProvider } from './platform-provider'

const ORG_TOKEN = (() => {
  const header = Buffer.from('{"alg":"none"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ orgId: 'org_42' })).toString('base64url')
  return `${header}.${payload}.sig`
})()

const ACCESS_KEY = 'opaque_key_xyz'

describe('PlatformLlmProvider.getContainerEnvVars', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('injects ANTHROPIC_CUSTOM_HEADERS with X-Platform-Member-Id when attributed', () => {
    mockGetPlatformAccessToken.mockReturnValue(ORG_TOKEN)
    const provider = new PlatformLlmProvider()

    const env = runWithRequestUser('user_alice', () => provider.getContainerEnvVars()) as Record<string, string | undefined>

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(ORG_TOKEN)
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Platform-Member-Id: sub_alice')
  })

  it('omits ANTHROPIC_CUSTOM_HEADERS for opaque access-key tokens', () => {
    mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY)
    const provider = new PlatformLlmProvider()

    const env = runWithRequestUser('user_alice', () => provider.getContainerEnvVars()) as Record<string, string | undefined>

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(ACCESS_KEY)
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  it('omits ANTHROPIC_CUSTOM_HEADERS when no attribution scope is active', () => {
    mockGetPlatformAccessToken.mockReturnValue(ORG_TOKEN)
    const provider = new PlatformLlmProvider()

    const env = provider.getContainerEnvVars()

    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })
})

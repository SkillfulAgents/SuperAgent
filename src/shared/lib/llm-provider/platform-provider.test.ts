import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPlatformAccessToken = vi.fn()
const mockGetPlatformBearerWithMember = vi.fn()
const mockGetPlatformProxyBaseUrl = vi.fn()
const mockGetOwnerAccountIdForProvider = vi.fn()
const mockIsAuthMode = vi.fn()

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
  getPlatformBearerWithMember: (memberId: string | null) => mockGetPlatformBearerWithMember(memberId),
}))

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => mockGetPlatformProxyBaseUrl(),
}))

vi.mock('@shared/lib/platform-auth/agent-owner', () => ({
  getOwnerAccountIdForProvider: (agentSlug: string, providerId: string) =>
    mockGetOwnerAccountIdForProvider(agentSlug, providerId),
}))

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

import { PlatformLlmProvider } from './platform-provider'

describe('PlatformLlmProvider.getContainerEnvVars', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv }
    mockGetPlatformProxyBaseUrl.mockReturnValue('http://localhost:8787')
    mockGetPlatformAccessToken.mockReturnValue('platform-token-abc')
    mockGetPlatformBearerWithMember.mockImplementation(
      (memberId: string | null) => memberId ? `platform-token-abc:${memberId}` : 'platform-token-abc',
    )
  })

  const build = (agentId: string) => {
    const provider = new PlatformLlmProvider()
    return provider.getContainerEnvVars(agentId)
  }

  it('rewrites localhost to host.docker.internal', () => {
    mockIsAuthMode.mockReturnValue(false)

    const env = build('agent-1')

    expect(env.ANTHROPIC_BASE_URL).toBe('http://host.docker.internal:8787')
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('platform-token-abc')
  })

  it('embeds owner memberId in bearer token in auth mode', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockGetOwnerAccountIdForProvider.mockReturnValue('sub_member_xyz')

    const env = build('agent-42')

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('platform-token-abc:sub_member_xyz')
    expect(mockGetOwnerAccountIdForProvider).toHaveBeenCalledWith('agent-42', 'platform')
    expect(env).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS')
  })

  it('falls back to plain token when owner is unresolvable', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockGetOwnerAccountIdForProvider.mockReturnValue(null)

    const env = build('orphan-agent')

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('platform-token-abc')
  })

  it('leaves non-loopback base URLs untouched', () => {
    mockIsAuthMode.mockReturnValue(false)
    mockGetPlatformProxyBaseUrl.mockReturnValue('https://proxy.platform.example.com')

    const env = build('agent-1')

    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.platform.example.com')
  })
})

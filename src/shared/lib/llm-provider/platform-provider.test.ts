import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPlatformAccessToken = vi.fn()
const mockGetPlatformProxyBaseUrl = vi.fn()
const mockFromAgentOwner = vi.fn()

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => mockGetPlatformProxyBaseUrl(),
}))

vi.mock('@shared/lib/attribution', () => ({
  attribution: {
    fromAgentOwner: (slug: string) => mockFromAgentOwner(slug),
  },
}))

import { PlatformLlmProvider } from './platform-provider'

function buildOrgToken(orgId: string): string {
  const header = Buffer.from('{"alg":"none"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ orgId })).toString('base64url')
  return `${header}.${payload}.sig`
}

const ORG_JWT = buildOrgToken('org_test_xyz')
const ACCESS_KEY = 'opaque-access-key-abc'

// Helper: build an Attribution mock that emits a member header for org-
// scoped tokens, and only the Authorization header for access keys --
// mirroring the real PlatformAttribution behaviour the test would
// otherwise reach into.
function makeAttr(token: string, memberId: string | null) {
  const orgScoped = token.split('.').length === 3
  const extras: Array<[string, string]> =
    orgScoped && memberId ? [['X-Platform-Member-Id', memberId]] : []
  const all: Array<[string, string]> = [['Authorization', `Bearer ${token}`], ...extras]
  return {
    applyTo: (h: Headers) => all.forEach(([k, v]) => h.set(k, v)),
    toHeaderEntries: () => all,
    toExtraHeaderEntries: () => extras,
    getKey: () => (!orgScoped ? 'access_key' : memberId ? `member:${memberId}` : 'org'),
  }
}

describe('PlatformLlmProvider.getContainerEnvVars', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv }
    mockGetPlatformProxyBaseUrl.mockReturnValue('http://localhost:8787')
  })

  const build = (agentId: string) => {
    const provider = new PlatformLlmProvider()
    return provider.getContainerEnvVars(agentId)
  }

  it('rewrites localhost to host.docker.internal', () => {
    mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY)
    mockFromAgentOwner.mockReturnValue(makeAttr(ACCESS_KEY, null))

    const env = build('agent-1')

    expect(env.ANTHROPIC_BASE_URL).toBe('http://host.docker.internal:8787')
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(ACCESS_KEY)
    // Access-key tokens never emit ANTHROPIC_CUSTOM_HEADERS -- the proxy
    // ignores the member header on that path, so emitting it would
    // diverge from the pre-refactor wire format.
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  it('serialises member attribution into ANTHROPIC_CUSTOM_HEADERS for org-scoped installs', () => {
    mockGetPlatformAccessToken.mockReturnValue(ORG_JWT)
    mockFromAgentOwner.mockReturnValue(makeAttr(ORG_JWT, 'sub_member_xyz'))

    const env = build('agent-42')

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(ORG_JWT)
    expect(mockFromAgentOwner).toHaveBeenCalledWith('agent-42')
    // claude-agent-sdk parses ANTHROPIC_CUSTOM_HEADERS as newline-
    // delimited "Header-Name: value" entries (NOT JSON). Authorization
    // is omitted -- it lives in ANTHROPIC_AUTH_TOKEN already.
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Platform-Member-Id: sub_member_xyz')
  })

  it('omits ANTHROPIC_CUSTOM_HEADERS when the agent owner is unresolvable', () => {
    mockGetPlatformAccessToken.mockReturnValue(ORG_JWT)
    mockFromAgentOwner.mockReturnValue(makeAttr(ORG_JWT, null))

    const env = build('orphan-agent')

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(ORG_JWT)
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  it('leaves non-loopback base URLs untouched', () => {
    mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY)
    mockFromAgentOwner.mockReturnValue(makeAttr(ACCESS_KEY, null))
    mockGetPlatformProxyBaseUrl.mockReturnValue('https://proxy.platform.example.com')

    const env = build('agent-1')

    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.platform.example.com')
  })
})

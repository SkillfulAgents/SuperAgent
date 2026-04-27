import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetPlatformAccessToken = vi.fn()
const mockGetPlatformProxyBaseUrl = vi.fn()
const mockFromCurrentRequest = vi.fn()

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => mockGetPlatformProxyBaseUrl(),
}))

vi.mock('@shared/lib/attribution', () => ({
  attribution: {
    fromCurrentRequest: () => mockFromCurrentRequest(),
  },
}))

import { PlatformSttProvider } from './platform-provider'

function makeAttribution(memberId: string) {
  return {
    applyTo(headers: Headers) {
      headers.set('Authorization', 'Bearer plat_token_123')
      headers.set('X-Platform-Member-Id', memberId)
    },
    toHeaderEntries() {
      return [
        ['Authorization', 'Bearer plat_token_123'],
        ['X-Platform-Member-Id', memberId],
      ] as Array<[string, string]>
    },
      toExtraHeaderEntries() { return this.toHeaderEntries().filter(([n]) => n !== "Authorization") },
    getKey() {
      return `member:${memberId}`
    },
  }
}

describe('PlatformSttProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPlatformAccessToken.mockReturnValue('plat_token_123')
    mockGetPlatformProxyBaseUrl.mockReturnValue('https://proxy.example.com')
    // Default: resolver returns request-scoped attribution. Routes seed
    // ALS via the Authenticated middleware in production; the test bypasses
    // that by mocking the resolver directly.
    mockFromCurrentRequest.mockReturnValue(makeAttribution('sub_user'))
  })

  it('attributes ephemeral tokens to the current request user', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'deepgram_ephemeral_token' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const provider = new PlatformSttProvider()
    const result = await provider.getEphemeralToken()

    expect(result.token).toBe('deepgram_ephemeral_token')
    expect(mockFromCurrentRequest).toHaveBeenCalled()
    const headers = fetchSpy.mock.calls[0][1].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer plat_token_123')
    expect(headers.get('X-Platform-Member-Id')).toBe('sub_user')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('throws when no outbound auth resolves for the current request', async () => {
    mockFromCurrentRequest.mockReturnValue(null)

    const provider = new PlatformSttProvider()
    await expect(provider.getEphemeralToken()).rejects.toThrow('No API key configured')
  })

  it('reuses the request-scoped resolver for voice agent tokens', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'voice_agent_token' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const provider = new PlatformSttProvider()
    const result = await provider.getVoiceAgentToken()

    expect(result.token).toBe('voice_agent_token')
    const headers = fetchSpy.mock.calls[0][1].headers as Headers
    expect(headers.get('X-Platform-Member-Id')).toBe('sub_user')
  })

  it('uses raw bearer (no member attribution) for validateKey', async () => {
    // validateKey is a token-validity probe; no acting user, no
    // attribution. Just hits the proxy with `Authorization` and checks
    // for 200/401.
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    const provider = new PlatformSttProvider()
    const out = await provider.validateKey('ignored')

    expect(out.valid).toBe(true)
    // validateKey doesn't go through attribution at all -- raw bearer.
    expect(mockFromCurrentRequest).not.toHaveBeenCalled()
    const headers = fetchSpy.mock.calls[0][1].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer plat_token_123')
    expect(headers.get('X-Platform-Member-Id')).toBeNull()
  })
})

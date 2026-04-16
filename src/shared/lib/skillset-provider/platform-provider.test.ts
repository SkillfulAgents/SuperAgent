import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetPlatformProxyBaseUrl = vi.fn()
const mockGetPlatformAccessToken = vi.fn()
const mockGetPlatformAuthStatus = vi.fn()

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => mockGetPlatformProxyBaseUrl(),
}))

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
  getPlatformAuthStatus: () => mockGetPlatformAuthStatus(),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

import { PlatformSkillsetProvider } from './platform-provider'

const provider = new PlatformSkillsetProvider()

function makeRef(overrides: Partial<{ skillsetId: string; skillsetName: string; repoId: string; orgId: string }> = {}) {
  return {
    skillsetId: overrides.skillsetId ?? 'platform--repo-x--acme-skillset',
    skillsetUrl: 'http://platform.example/v1/skills/repo',
    skillsetName: overrides.skillsetName ?? 'acme-skillset',
    providerData: {
      repoId: overrides.repoId ?? 'repo-x',
      orgId: overrides.orgId ?? 'org_A',
    },
  }
}

describe('PlatformSkillsetProvider.resolveCloneUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPlatformProxyBaseUrl.mockReturnValue('https://platform.example')
    mockGetPlatformAccessToken.mockReturnValue('plat_test_token_xxxxx')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockGitUrlResponse(body: unknown, ok = true) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'err',
      json: async () => body,
      text: async () => JSON.stringify(body),
    }))
  }

  it('returns the URL when it is on the same origin as the platform proxy', async () => {
    mockGitUrlResponse({ url: 'https://platform.example/git/acme.git', defaultBranch: 'main' })
    const out = await provider.resolveCloneUrl('ignored', makeRef())
    expect(out).toBe('https://platform.example/git/acme.git')
  })

  it('rejects URLs on a different host than the proxy', async () => {
    mockGitUrlResponse({ url: 'https://evil.example/git/acme.git' })
    await expect(provider.resolveCloneUrl('ignored', makeRef())).rejects.toThrow(/not on an allowed host/)
  })

  it('rejects URLs pointing at private IPs (SSRF)', async () => {
    // Same origin check would pass only if proxy is also private; set both so
    // the only rejection is from private-host detection.
    mockGetPlatformProxyBaseUrl.mockReturnValue('http://127.0.0.1')
    mockGitUrlResponse({ url: 'http://127.0.0.1/git/acme.git' })
    await expect(provider.resolveCloneUrl('ignored', makeRef())).rejects.toThrow(/Unsafe clone URL host/)
  })

  it('rejects non-http schemes', async () => {
    mockGitUrlResponse({ url: 'ssh://git@platform.example/acme.git' })
    await expect(provider.resolveCloneUrl('ignored', makeRef())).rejects.toThrow(/Unsafe URL protocol/)
  })

  it('throws when the platform returns no URL', async () => {
    mockGitUrlResponse({ url: '' })
    await expect(provider.resolveCloneUrl('ignored', makeRef())).rejects.toThrow(/did not return a clone URL/)
  })

  it('throws when unauthenticated', async () => {
    mockGetPlatformAccessToken.mockReturnValue(null)
    await expect(provider.resolveCloneUrl('ignored', makeRef())).rejects.toThrow(/Platform not connected/)
  })
})

describe('PlatformSkillsetProvider.getQueueItemStatuses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPlatformProxyBaseUrl.mockReturnValue('https://platform.example')
    mockGetPlatformAccessToken.mockReturnValue('plat_test_token_xxxxx')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns empty map without calling fetch when ids is empty', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const result = await provider.getQueueItemStatuses([])
    expect(result.size).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses a single batch request when the server supports it', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: {
          a: { status: 'merged' },
          b: { status: 'pending' },
          c: null,
        },
      }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await provider.getQueueItemStatuses(['a', 'b', 'c'])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const call = fetchSpy.mock.calls[0]
    expect(call[0]).toBe('https://platform.example/v1/skills/queue/batch')
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body)).toEqual({ ids: ['a', 'b', 'c'] })
    expect(result.get('a')).toBe('merged')
    expect(result.get('b')).toBe('pending')
    expect(result.get('c')).toBe(null)
  })

  it('falls back to per-id GETs when the batch endpoint is unavailable', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 }) // batch missing
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ item: { status: 'merged' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ item: { status: 'rejected' } }) })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await provider.getQueueItemStatuses(['a', 'b'])
    expect(fetchSpy).toHaveBeenCalledTimes(3) // batch + 2 per-id
    expect(result.get('a')).toBe('merged')
    expect(result.get('b')).toBe('rejected')
  })

  it('returns nulls when unauthenticated', async () => {
    mockGetPlatformAccessToken.mockReturnValue(null)
    const result = await provider.getQueueItemStatuses(['a', 'b'])
    expect(result.get('a')).toBe(null)
    expect(result.get('b')).toBe(null)
  })
})

describe('PlatformSkillsetProvider.isConfigValid / isInstalledValid', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('github configs are always valid', () => {
    mockGetPlatformAuthStatus.mockReturnValue({ orgId: null })
    const valid = provider.isConfigValid({
      id: 'github--foo',
      url: 'https://github.com/example/foo.git',
      name: 'foo',
      description: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      provider: 'github',
    })
    expect(valid).toBe(true)
  })

  it('platform config is valid only when orgId matches current auth', () => {
    mockGetPlatformAuthStatus.mockReturnValue({ orgId: 'org_A' })
    const make = (orgId: string) => ({
      id: 'platform--x',
      url: 'u',
      name: 'x',
      description: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      provider: 'platform' as const,
      providerData: { orgId, repoId: 'r' },
    })
    expect(provider.isConfigValid(make('org_A'))).toBe(true)
    expect(provider.isConfigValid(make('org_B'))).toBe(false)
  })

  it('platform config invalid when disconnected', () => {
    mockGetPlatformAuthStatus.mockReturnValue({ orgId: null })
    expect(provider.isConfigValid({
      id: 'platform--x',
      url: 'u',
      name: 'x',
      description: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      provider: 'platform',
      providerData: { orgId: 'org_A', repoId: 'r' },
    })).toBe(false)
  })

  it('isInstalledValid checks orgId match the same way', () => {
    mockGetPlatformAuthStatus.mockReturnValue({ orgId: 'org_A' })
    expect(provider.isInstalledValid({
      provider: 'platform',
      providerData: { orgId: 'org_A' },
    })).toBe(true)
    expect(provider.isInstalledValid({
      provider: 'platform',
      providerData: { orgId: 'org_B' },
    })).toBe(false)
    expect(provider.isInstalledValid({ provider: 'github' })).toBe(true)
  })
})

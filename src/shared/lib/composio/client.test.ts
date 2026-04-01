import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock settings before importing client
const mockGetEffectiveComposioApiKey = vi.fn()
const mockGetComposioUserId = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveComposioApiKey: () => mockGetEffectiveComposioApiKey(),
  getComposioUserId: () => mockGetComposioUserId(),
}))

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => null,
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { getConnectionToken, ComposioApiError } from './client'

function makeComposioResponse(
  state: { authScheme: string; val: Record<string, unknown> },
  overrides: Record<string, unknown> = {}
) {
  return {
    id: 'conn-1',
    status: 'ACTIVE',
    toolkit: { slug: 'gmail' },
    auth_config: { id: 'ac-1', auth_scheme: 'OAUTH2', is_composio_managed: true },
    state,
    ...overrides,
  }
}

describe('getConnectionToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetEffectiveComposioApiKey.mockReturnValue('test-api-key')
    mockGetComposioUserId.mockReturnValue('test-user')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockFetchOk(body: unknown) {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => body,
    })
  }

  function mockFetchError(status: number, body: unknown) {
    mockFetch.mockResolvedValue({
      ok: false,
      status,
      json: async () => body,
    })
  }

  it('extracts access_token for OAUTH2 scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: 'ya29.oauth2-token' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe('ya29.oauth2-token')
  })

  it('extracts oauth_token for OAUTH1 scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH1',
      val: { status: 'ACTIVE', oauth_token: 'oauth1-token-value' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe('oauth1-token-value')
  })

  it('extracts api_key for API_KEY scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'API_KEY',
      val: { status: 'ACTIVE', api_key: 'my-api-key-123' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe('my-api-key-123')
  })

  it('falls back to generic_api_key for API_KEY scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'API_KEY',
      val: { status: 'ACTIVE', generic_api_key: 'generic-key-456' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe('generic-key-456')
  })

  it('extracts token for BEARER_TOKEN scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'BEARER_TOKEN',
      val: { status: 'ACTIVE', token: 'bearer-tok-789' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe('bearer-tok-789')
  })

  it('falls back to access_token for unknown scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'CUSTOM_SCHEME',
      val: { status: 'ACTIVE', access_token: 'fallback-token' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe('fallback-token')
  })

  it('throws when state.val is missing', async () => {
    mockFetchOk({
      id: 'conn-1',
      status: 'ACTIVE',
      toolkit: { slug: 'gmail' },
      auth_config: { id: 'ac-1', auth_scheme: 'OAUTH2', is_composio_managed: true },
      state: { authScheme: 'OAUTH2' },
      // no val
    })

    await expect(getConnectionToken('conn-1')).rejects.toThrow('No state data found')
  })

  it('throws when no token found for scheme', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE' }, // no access_token
    }))

    await expect(getConnectionToken('conn-1')).rejects.toThrow('No access token found')
  })

  it('detects redacted tokens (short + ends with ...)', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: 'ya29.abc...' },
    }))

    await expect(getConnectionToken('conn-1')).rejects.toThrow('redacted')
    try {
      await getConnectionToken('conn-1')
    } catch (e) {
      expect((e as ComposioApiError).statusCode).toBe(403)
    }
  })

  it('accepts long tokens that happen to end with ...', async () => {
    const longToken = 'a'.repeat(25) + '...'
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: longToken },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.accessToken).toBe(longToken)
  })

  it('calculates expiresAt from expires_in', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: 'token-123', expires_in: 3600 },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.expiresAt).toBeDefined()
    const expectedExpiry = new Date(now + 3600 * 1000).toISOString()
    expect(result.expiresAt).toBe(expectedExpiry)
  })

  it('omits expiresAt when expires_in is absent', async () => {
    mockFetchOk(makeComposioResponse({
      authScheme: 'OAUTH2',
      val: { status: 'ACTIVE', access_token: 'token-no-expiry' },
    }))

    const result = await getConnectionToken('conn-1')
    expect(result.expiresAt).toBeUndefined()
  })

  it('throws ComposioApiError on non-ok API response', async () => {
    mockFetchError(500, { error: 'Internal server error', message: 'Something broke' })

    await expect(getConnectionToken('conn-1')).rejects.toThrow(ComposioApiError)
    try {
      await getConnectionToken('conn-1')
    } catch (e) {
      expect(e).toBeInstanceOf(ComposioApiError)
      expect((e as ComposioApiError).statusCode).toBe(500)
    }
  })

  it('throws 401 when API key is not configured', async () => {
    mockGetEffectiveComposioApiKey.mockReturnValue(null)

    await expect(getConnectionToken('conn-1')).rejects.toThrow('not configured')
    try {
      await getConnectionToken('conn-1')
    } catch (e) {
      expect((e as ComposioApiError).statusCode).toBe(401)
    }
  })
})

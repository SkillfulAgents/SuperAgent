import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

import { getGenericOAuthProviderConfigs, getPublicAuthProviders } from './provider-config'

describe('getPublicAuthProviders', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.AUTH_PROVIDERS_JSON
  })

  it('returns enabled providers with readiness details', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      {
        id: 'company-sso',
        type: 'oidc',
        displayName: 'Company SSO',
        discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
        clientId: 'cloud-superagent',
        clientSecret: 'secret',
      },
    ])

    expect(getPublicAuthProviders()).toEqual([
      {
        id: 'company-sso',
        type: 'oidc',
        displayName: 'Company SSO',
        icon: null,
        enabled: true,
        available: true,
        readiness: {
          ok: true,
          reasons: [],
        },
      },
    ])
  })

  it('marks a provider unavailable when required oidc config is missing', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      {
        id: 'company-sso',
        type: 'oidc',
        enabled: true,
        displayName: 'Company SSO',
      },
    ])

    expect(getPublicAuthProviders()).toEqual([
      {
        id: 'company-sso',
        type: 'oidc',
        displayName: 'Company SSO',
        icon: null,
        enabled: true,
        available: false,
        readiness: {
          ok: false,
          reasons: ['Missing discovery URL or issuer', 'Missing client ID'],
        },
      },
    ])
  })

  it('builds providers from AUTH_PROVIDERS_JSON when settings do not define one', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      {
        id: 'company-sso',
        type: 'oidc',
        displayName: 'Company SSO',
        issuer: 'https://auth.example.com',
        clientId: 'superagent-local',
        clientSecret: 'env-secret',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
      },
    ])
    expect(getPublicAuthProviders()).toEqual([
      {
        id: 'company-sso',
        type: 'oidc',
        displayName: 'Company SSO',
        icon: null,
        enabled: true,
        available: true,
        readiness: {
          ok: true,
          reasons: [],
        },
      },
    ])
  })

  it('returns no providers when AUTH_PROVIDERS_JSON is unset', () => {
    expect(getPublicAuthProviders()).toEqual([])
  })

  it('filters disabled providers from public and OAuth configs', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      {
        id: 'disabled-sso',
        type: 'oidc',
        enabled: false,
        issuer: 'https://disabled.example.com',
        clientId: 'disabled-client',
      },
      {
        id: 'enabled-sso',
        type: 'oidc',
        issuer: 'https://enabled.example.com',
        clientId: 'enabled-client',
      },
    ])

    expect(getPublicAuthProviders().map((provider) => provider.id)).toEqual(['enabled-sso'])
    expect(getGenericOAuthProviderConfigs().map((provider) => provider.providerId)).toEqual(['enabled-sso'])
  })

  it('rejects the whole AUTH_PROVIDERS_JSON when any entry is malformed', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      {
        id: 'company-sso',
        type: 'oidc',
        issuer: 'https://auth.example.com',
        clientId: 'client',
      },
      {
        id: 123,
        type: 'oidc',
      },
    ])

    expect(getPublicAuthProviders()).toEqual([])
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: expect.objectContaining({ area: 'auth', op: 'schema-env-providers' }),
      }),
    )
  })

  it('does not expose clientSecret in public provider config', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      {
        id: 'company-sso',
        type: 'oidc',
        issuer: 'https://auth.example.com',
        clientId: 'client',
        clientSecret: 'secret',
      },
    ])

    expect(JSON.stringify(getPublicAuthProviders())).not.toContain('secret')
  })

  it('lets provider definitions produce Better Auth OAuth config', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      {
        id: 'company-sso',
        type: 'oidc',
        issuer: 'https://auth.env.example.com',
        clientId: 'env-client',
        clientSecret: 'env-secret',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
      },
    ])
    expect(getGenericOAuthProviderConfigs()).toEqual([
      {
        providerId: 'company-sso',
        discoveryUrl: undefined,
        issuer: 'https://auth.env.example.com',
        clientId: 'env-client',
        clientSecret: 'env-secret',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        pkce: true,
        accessType: 'offline',
        requireIssuerValidation: true,
        overrideUserInfo: true,
        mapProfileToUser: expect.any(Function),
      },
    ])
  })

  it('mapProfileToUser extracts platform user_id claim as id', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'platform', type: 'oidc', issuer: 'https://auth.example.com', clientId: 'c' },
    ])
    const [config] = getGenericOAuthProviderConfigs()
    expect(config.mapProfileToUser!({
      sub: 'sub_member_123',
      email: 'user@example.com',
      'https://platform.skillfulagents.dev/claims/user_id': 'uuid-user-456',
    })).toEqual({ id: 'uuid-user-456' })
  })

  it('mapProfileToUser returns empty object when user_id claim is absent', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'platform', type: 'oidc', issuer: 'https://auth.example.com', clientId: 'c' },
    ])
    const [config] = getGenericOAuthProviderConfigs()
    expect(config.mapProfileToUser!({
      sub: 'sub_member_123',
      email: 'user@example.com',
    })).toEqual({})
  })

  it('reports invalid AUTH_PROVIDERS_JSON to error reporting instead of silently dropping', () => {
    process.env.AUTH_PROVIDERS_JSON = '{not-json'

    expect(getPublicAuthProviders()).toEqual([])
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ area: 'auth' }) }),
    )
  })
})

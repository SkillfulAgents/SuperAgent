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

  it('does not expose bundled providers before their activation env is set', () => {
    expect(getPublicAuthProviders()).toEqual([])
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
      },
    ])
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

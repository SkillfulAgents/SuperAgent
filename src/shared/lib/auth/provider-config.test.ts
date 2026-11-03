import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCaptureException = vi.fn()
let mockAppBaseUrl = 'https://deployment.example.com'
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))
vi.mock('./config', () => ({
  getAppBaseUrl: () => mockAppBaseUrl,
}))

import { getGenericOAuthProviderConfigs, getPublicAuthProviders } from './provider-config'

// Build an unsigned org access JWT (header.payload.sig) carrying { orgId } so
// decodeOrgIdFromToken(process.env.PLATFORM_TOKEN) resolves the deployment org.
function makeOrgToken(orgId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ orgId })}.sig`
}

describe('getPublicAuthProviders', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockAppBaseUrl = 'https://deployment.example.com'
    delete process.env.AUTH_PROVIDERS_JSON
    delete process.env.PLATFORM_TOKEN
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
        discoveryUrl: 'https://auth.env.example.com/.well-known/openid-configuration',
        redirectURI: 'https://deployment.example.com/api/auth/oauth2/callback/company-sso',
        clientId: 'env-client',
        clientSecret: 'env-secret',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        pkce: true,
        accessType: 'offline',
        requireIdTokenVerification: true,
        disableProviderLogout: true,
        overrideUserInfo: true,
        accountSubject: expect.any(Function),
        mapProfileToUser: expect.any(Function),
      },
    ])
  })

  it('prefers explicit discovery and keeps issuer-only settings compatible with OIDC discovery', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      {
        id: 'explicit', type: 'oidc', issuer: 'https://auth.example.com/tenant',
        discoveryUrl: 'https://discovery.example.com/oidc.json', clientId: 'client',
      },
      { id: 'derived', type: 'oidc', issuer: 'https://auth.example.com/tenant/', clientId: 'client' },
    ])

    const [explicit, derived] = getGenericOAuthProviderConfigs()
    expect(explicit.discoveryUrl).toBe('https://discovery.example.com/oidc.json')
    expect(derived.discoveryUrl).toBe('https://auth.example.com/tenant/.well-known/openid-configuration')
    expect(explicit).not.toHaveProperty('issuer')
    expect(explicit).not.toHaveProperty('requireIssuerValidation')
  })

  it('encodes provider ids within the registered callback path', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'company/sso?next=other', type: 'oidc', issuer: 'https://auth.example.com', clientId: 'client' },
    ])
    const [config] = getGenericOAuthProviderConfigs()
    expect(config.redirectURI).toBe(
      'https://deployment.example.com/api/auth/oauth2/callback/company%2Fsso%3Fnext%3Dother',
    )
  })

  it.each(['/', '///'])('preserves the registered callback when the app base URL ends in %s', (suffix) => {
    mockAppBaseUrl += suffix
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'company-sso', type: 'oidc', issuer: 'https://auth.example.com', clientId: 'client' },
    ])

    expect(getGenericOAuthProviderConfigs()[0].redirectURI).toBe(
      'https://deployment.example.com/api/auth/oauth2/callback/company-sso',
    )
  })

  it('derives account identity only from the OIDC subject', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'platform', type: 'oidc', issuer: 'https://auth.example.com', clientId: 'client' },
    ])
    const [config] = getGenericOAuthProviderConfigs()
    expect(config.accountSubject({ profile: { sub: 'member-123', id: 'mutable-user-id' } })).toBe('member-123')
    for (const sub of [undefined, null, '', 123]) {
      expect(() => config.accountSubject({ profile: { sub, id: 'fallback-id' } })).toThrow(/missing its subject/)
    }
  })

  it('mapProfileToUser never overrides id, so account.accountId stays the OIDC sub', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'platform', type: 'oidc', issuer: 'https://auth.example.com', clientId: 'c' },
    ])
    const [config] = getGenericOAuthProviderConfigs()
    expect(config.mapProfileToUser!({
      sub: 'sub_member_123',
      email: 'user@example.com',
      email_verified: true,
      'https://platform.skillfulagents.dev/claims/user_id': 'uuid-user-456',
    })).toEqual({})
  })

  // Attribution invariant guard. The proxy attributes org-scoped requests as
  // `<token>::<memberId>`, where memberId is read verbatim from better-auth
  // `authAccount.accountId` (see platform-attribution/index.ts). better-auth
  // sets accountId to the OIDC `sub`, and the platform issuer sets `sub` = the
  // member id (`sub_…`), NOT the platform user id (a Supabase UUID). Mapping the
  // user_id claim into the better-auth identity silently retargets every
  // org-scoped request to the wrong member. This test fails loudly if that
  // benign-looking member-id → user-id switch is ever reintroduced.
  it('keeps the member id (OIDC sub) as the account identity and never adopts the platform user id', () => {
    const MEMBER_ID = 'sub_member_123'
    const PLATFORM_USER_ID = 'uuid-user-456'
    const USER_ID_CLAIM = 'https://platform.skillfulagents.dev/claims/user_id'

    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'platform', type: 'oidc', issuer: 'https://auth.example.com', clientId: 'c' },
    ])
    delete process.env.PLATFORM_TOKEN

    const [config] = getGenericOAuthProviderConfigs()
    const mapped = config.mapProfileToUser!({
      sub: MEMBER_ID,
      email: 'user@example.com',
      email_verified: true,
      [USER_ID_CLAIM]: PLATFORM_USER_ID,
    }) as Record<string, unknown>

    const leakedFields = Object.entries(mapped)
      .filter(([, value]) => value === PLATFORM_USER_ID)
      .map(([key]) => key)
    expect(
      leakedFields,
      `mapProfileToUser leaked the platform user_id (${PLATFORM_USER_ID}) into [${leakedFields.join(
        ', ',
      )}]. Attribution reads better-auth authAccount.accountId (the OIDC sub) as the acting member id, ` +
        `so the account identity MUST stay the member id (${MEMBER_ID}), not the platform user id. ` +
        `Do not map the user_id claim into the better-auth user — see platform-attribution/index.ts.`,
    ).toEqual([])

    // An overridden `id` would repoint the better-auth user away from the sub.
    if ('id' in mapped) {
      expect(
        mapped.id,
        'mapProfileToUser set `id` to a non-member value. If `id` is set at all it must be the member id (the OIDC sub).',
      ).toBe(MEMBER_ID)
    }
  })

  it('mapProfileToUser rejects an unverified Platform email', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'platform', type: 'oidc', issuer: 'https://auth.example.com', clientId: 'c' },
    ])
    delete process.env.PLATFORM_TOKEN
    const [config] = getGenericOAuthProviderConfigs()
    expect(() =>
      config.mapProfileToUser!({
        sub: 'sub_member_123',
        email: 'user@example.com',
        email_verified: false,
      }),
    ).toThrow(/not verified/i)
  })

  it('mapProfileToUser does not require email_verified for non-Platform OIDC providers', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'company-sso', type: 'oidc', issuer: 'https://sso.example.com', clientId: 'c' },
    ])
    delete process.env.PLATFORM_TOKEN
    const [config] = getGenericOAuthProviderConfigs()
    expect(
      config.mapProfileToUser!({
        sub: 'user-123',
        email: 'user@example.com',
      }),
    ).toEqual({})
  })

  it('mapProfileToUser rejects an id_token whose org_id differs from the deployment org', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'platform', type: 'oidc', issuer: 'https://auth.example.com', clientId: 'c' },
    ])
    process.env.PLATFORM_TOKEN = makeOrgToken('org_AAA')
    const [config] = getGenericOAuthProviderConfigs()
    expect(() =>
      config.mapProfileToUser!({
        sub: 'sub_member_123',
        email_verified: true,
        'https://platform.skillfulagents.dev/claims/org_id': 'org_BBB',
      }),
    ).toThrow(/different organization/i)
  })

  it('mapProfileToUser passes when the id_token org_id matches the deployment org', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'platform', type: 'oidc', issuer: 'https://auth.example.com', clientId: 'c' },
    ])
    process.env.PLATFORM_TOKEN = makeOrgToken('org_AAA')
    const [config] = getGenericOAuthProviderConfigs()
    expect(
      config.mapProfileToUser!({
        sub: 'sub_member_123',
        email_verified: true,
        'https://platform.skillfulagents.dev/claims/org_id': 'org_AAA',
      }),
    ).toEqual({})
  })

  it('mapProfileToUser rejects an id_token with no org_id claim on an org-pinned deployment', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'platform', type: 'oidc', issuer: 'https://auth.example.com', clientId: 'c' },
    ])
    process.env.PLATFORM_TOKEN = makeOrgToken('org_AAA')
    const [config] = getGenericOAuthProviderConfigs()
    expect(() =>
      config.mapProfileToUser!({
        sub: 'sub_member_123',
        email: 'user@example.com',
        email_verified: true,
      }),
    ).toThrow(/different organization/i)
  })

  it('mapProfileToUser skips the org check when no PLATFORM_TOKEN is configured', () => {
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'platform', type: 'oidc', issuer: 'https://auth.example.com', clientId: 'c' },
    ])
    delete process.env.PLATFORM_TOKEN
    const [config] = getGenericOAuthProviderConfigs()
    expect(
      config.mapProfileToUser!({
        sub: 'sub_member_123',
        email_verified: true,
        'https://platform.skillfulagents.dev/claims/org_id': 'org_BBB',
      }),
    ).toEqual({})
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

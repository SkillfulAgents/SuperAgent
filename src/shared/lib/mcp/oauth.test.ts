import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as dnsPromises from 'node:dns/promises'

// Mock DB with chainable query builder
const mockLimit = vi.fn()
const mockWhere = vi.fn()
const mockSet = vi.fn()
const mockDbFrom = vi.fn()
const mockInsertValues = vi.fn()

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return {
    ...actual,
    lookup: vi.fn(),
  }
})

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: mockDbFrom }),
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: mockSet }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  remoteMcpServers: { id: 'id', oauthClientId: 'oauth_client_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const lookupMock = dnsPromises.lookup as unknown as ReturnType<typeof vi.fn>

// Must import after mocks
import {
  discoverOAuthMetadata,
  registerDynamicClient,
  initiateOAuthFlow,
  initiateNewServerOAuth,
  McpOAuthSetupError,
  completeOAuthFlow,
  validateAndConsumeOAuthErrorResponse,
  refreshMcpToken,
} from './oauth'

describe('oauth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Public fixture hostnames must resolve publicly for the DNS SSRF gate.
    lookupMock.mockResolvedValue({ address: '93.184.216.34', family: 4 })
  })

  // =========================================================================
  // generatePKCE (tested indirectly through initiateNewServerOAuth)
  // =========================================================================
  describe('generatePKCE (via authorization URL)', () => {
    it('generates a valid S256 code_challenge in the authorization URL', async () => {
      // Setup: discoverOAuthMetadata returns valid metadata
      // First call: probe → 401 with WWW-Authenticate
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        })
      )
      // Second call: resource metadata
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com',
            authorization_servers: ['https://auth.example.com'],
          }),
          { status: 200 }
        )
      )
      // Third call: well-known oauth-authorization-server
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
          }),
          { status: 200 }
        )
      )
      // Fourth call: dynamic client registration
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            client_id: 'dynamic-client-123',
          }),
          { status: 200 }
        )
      )

      const result = await initiateNewServerOAuth(
        'https://mcp.example.com/mcp',
        'Test Server',
        ['http://localhost:3000/callback'],
        false,
        'user-1'
      )

      expect(result).not.toBeNull()
      const url = new URL(result!.authorizationUrl)

      // Verify code_challenge is present and is base64url encoded
      const codeChallenge = url.searchParams.get('code_challenge')
      expect(codeChallenge).toBeTruthy()
      // base64url: only contains [A-Za-z0-9_-], no padding
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/)

      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    })
  })

  // =========================================================================
  // discoverOAuthMetadata
  // =========================================================================
  describe('discoverOAuthMetadata', () => {
    it('discovers metadata via 401 with WWW-Authenticate header', async () => {
      // Probe: 401 with resource_metadata
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        })
      )
      // Resource metadata fetch
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com',
            authorization_servers: ['https://auth.example.com'],
          }),
          { status: 200 }
        )
      )
      // OAuth authorization server metadata
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
          }),
          { status: 200 }
        )
      )

      const result = await discoverOAuthMetadata('https://mcp.example.com/mcp')
      expect(result).not.toBeNull()
      expect(result!.metadata.authorization_endpoint).toBe(
        'https://auth.example.com/authorize'
      )
      expect(result!.metadata.token_endpoint).toBe(
        'https://auth.example.com/token'
      )
      expect(result!.resource).toBe('https://mcp.example.com')
    })

    it('falls back to well-known URLs when no WWW-Authenticate resource_metadata', async () => {
      // Probe: 401 but no resource_metadata in header
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer' },
        })
      )
      // First well-known: RFC 8414
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://mcp.example.com/authorize',
            token_endpoint: 'https://mcp.example.com/token',
          }),
          { status: 200 }
        )
      )

      const result = await discoverOAuthMetadata('https://mcp.example.com/mcp')
      expect(result).not.toBeNull()
      expect(result!.metadata.authorization_endpoint).toBe(
        'https://mcp.example.com/authorize'
      )
      expect(result!.resource).toBe('https://mcp.example.com')
    })

    it('tries openid-configuration when oauth-authorization-server fails', async () => {
      // Probe: 401 without resource_metadata
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer' },
        })
      )
      // First well-known (RFC 8414): fails
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }))
      // Second well-known (OpenID Connect): succeeds
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://mcp.example.com/oidc/auth',
            token_endpoint: 'https://mcp.example.com/oidc/token',
          }),
          { status: 200 }
        )
      )

      const result = await discoverOAuthMetadata('https://mcp.example.com/mcp')
      expect(result).not.toBeNull()
      expect(result!.metadata.authorization_endpoint).toBe(
        'https://mcp.example.com/oidc/auth'
      )
    })

    it('returns null when server does not return 401 (no auth needed)', async () => {
      // Probe: 200 OK — no auth required
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: '2.0', result: {} }), {
          status: 200,
        })
      )

      const result = await discoverOAuthMetadata('https://mcp.example.com/mcp')
      expect(result).toBeNull()
    })

    it('returns null when no well-known endpoints have valid metadata', async () => {
      // Probe: 401
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer' },
        })
      )
      // Both well-known URLs fail
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }))
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }))

      const result = await discoverOAuthMetadata('https://mcp.example.com/mcp')
      expect(result).toBeNull()
    })

    it('discovers metadata at RFC 8414 path-aware well-known URL', async () => {
      // Mirrors Meta's MCP: auth server is https://mcp.facebook.com/ads but
      // metadata only lives at https://mcp.facebook.com/.well-known/oauth-authorization-server/ads.
      // Probe: 401
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/ads"',
          },
        })
      )
      // Resource metadata: auth server URL has a path
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com/ads',
            authorization_servers: ['https://mcp.example.com/ads'],
          }),
          { status: 200 }
        )
      )
      // First well-known (RFC 8414 path-aware) succeeds
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://mcp.example.com/oauth/authorize',
            token_endpoint: 'https://mcp.example.com/oauth/token',
          }),
          { status: 200 }
        )
      )

      const result = await discoverOAuthMetadata('https://mcp.example.com/ads')
      expect(result).not.toBeNull()
      expect(result!.metadata.authorization_endpoint).toBe(
        'https://mcp.example.com/oauth/authorize'
      )
      // Verify the path-aware URL was tried first
      const wellKnownCall = mockFetch.mock.calls[2][0]
      expect(wellKnownCall).toBe(
        'https://mcp.example.com/.well-known/oauth-authorization-server/ads'
      )
    })

    it('falls back to appended-path well-known URL when path-aware variant fails', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/res"',
          },
        })
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com/srv',
            authorization_servers: ['https://mcp.example.com/srv'],
          }),
          { status: 200 }
        )
      )
      // Path-aware: 404
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }))
      // Appended: 200
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://mcp.example.com/srv/authorize',
            token_endpoint: 'https://mcp.example.com/srv/token',
          }),
          { status: 200 }
        )
      )

      const result = await discoverOAuthMetadata('https://mcp.example.com/srv')
      expect(result).not.toBeNull()
      expect(mockFetch.mock.calls[2][0]).toBe(
        'https://mcp.example.com/.well-known/oauth-authorization-server/srv'
      )
      expect(mockFetch.mock.calls[3][0]).toBe(
        'https://mcp.example.com/srv/.well-known/oauth-authorization-server'
      )
    })

    it('returns null when resource metadata fetch fails', async () => {
      // Probe: 401 with resource_metadata
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        })
      )
      // Resource metadata: fails
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }))

      const result = await discoverOAuthMetadata('https://mcp.example.com/mcp')
      expect(result).toBeNull()
    })
  })

  // =========================================================================
  // registerDynamicClient
  // =========================================================================
  describe('registerDynamicClient', () => {
    it('returns clientId, clientSecret, and scope on success', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            client_id: 'new-client-id',
            client_secret: 'new-secret',
            scope: 'mcp:read mcp:write',
          }),
          { status: 200 }
        )
      )

      const result = await registerDynamicClient(
        'https://auth.example.com/register',
        'http://localhost/callback',
        'Gamut'
      )
      expect(result).toEqual({
        clientId: 'new-client-id',
        clientSecret: 'new-secret',
        scope: 'mcp:read mcp:write',
      })
    })

    it('throws with HTTP status on registration failure', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 400 }))

      await expect(
        registerDynamicClient(
          'https://auth.example.com/register',
          'http://localhost/callback',
          'Gamut'
        )
      ).rejects.toThrow('The authorization server rejected client registration (HTTP 400)')
    })

    it('surfaces the error_description from a rejection body (Cloudflare Access case)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'invalid_client_metadata',
            error_description: 'redirect_uri is not allowed by the account configuration',
          }),
          { status: 400 }
        )
      )

      await expect(
        registerDynamicClient(
          'https://auth.example.com/register',
          'http://localhost/callback',
          'Gamut'
        )
      ).rejects.toThrow(
        'The authorization server rejected client registration (HTTP 400): invalid_client_metadata: redirect_uri is not allowed by the account configuration'
      )
    })

    it('surfaces a bare-text rejection body (Figma case)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))

      await expect(
        registerDynamicClient(
          'https://auth.example.com/register',
          'http://localhost/callback',
          'Gamut'
        )
      ).rejects.toThrow('The authorization server rejected client registration (HTTP 403): Forbidden')
    })

    it('throws a setup error on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      await expect(
        registerDynamicClient(
          'https://auth.example.com/register',
          'http://localhost/callback',
          'Gamut'
        )
      ).rejects.toThrow(McpOAuthSetupError)
    })
  })

  // =========================================================================
  // initiateOAuthFlow — authorization URL construction
  // =========================================================================
  describe('initiateOAuthFlow', () => {
    function setupDiscoveryMocks(options: {
      issuer?: string
      supportsIss?: boolean
    } = {}) {
      // Probe: 401 with resource_metadata
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/res"',
          },
        })
      )
      // Resource metadata
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com',
            authorization_servers: ['https://auth.example.com'],
          }),
          { status: 200 }
        )
      )
      // Auth server metadata
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            scopes_supported: ['read', 'write'],
            ...(options.issuer ? { issuer: options.issuer } : {}),
            ...(options.supportsIss === undefined
              ? {}
              : { authorization_response_iss_parameter_supported: options.supportsIss }),
          }),
          { status: 200 }
        )
      )
    }

    it('constructs authorization URL with correct params using existing clientId', async () => {
      setupDiscoveryMocks()

      // DB: existing server has oauthClientId
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        { oauthClientId: 'existing-client-id', oauthClientSecret: null },
      ])
      // DB update
      mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })

      const result = await initiateOAuthFlow(
        'mcp-1',
        'https://mcp.example.com/mcp',
        ['http://localhost:3000/callback']
      )

      expect(result).not.toBeNull()
      const url = new URL(result!.authorizationUrl)

      expect(url.origin).toBe('https://auth.example.com')
      expect(url.pathname).toBe('/authorize')
      expect(url.searchParams.get('response_type')).toBe('code')
      expect(url.searchParams.get('client_id')).toBe('existing-client-id')
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/callback'
      )
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('code_challenge')).toBeTruthy()
      expect(url.searchParams.get('state')).toBe(result!.state)
      // RFC 8707: resource indicator must be sent on the authorization request
      // so the AS binds the token audience to this MCP server.
      expect(url.searchParams.get('resource')).toBe('https://mcp.example.com')
      // MCP auth spec scope-selection strategy: with no `scope` in the 401
      // WWW-Authenticate, request all advertised scopes_supported — regardless
      // of whether the client was freshly registered or pre-existing.
      expect(url.searchParams.get('scope')).toBe('read write')
    })

    it('records issuer metadata for existing-server re-auth flows', async () => {
      setupDiscoveryMocks({
        issuer: 'https://auth.example.com',
        supportsIss: true,
      })

      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        { oauthClientId: 'existing-client-id', oauthClientSecret: null },
      ])
      mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })

      const initiated = await initiateOAuthFlow(
        'mcp-1',
        'https://mcp.example.com/mcp',
        ['http://localhost:3000/callback']
      )
      expect(initiated).not.toBeNull()

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-tok-123',
            token_type: 'Bearer',
          }),
          { status: 200 }
        )
      )

      const result = await completeOAuthFlow(
        initiated!.state,
        'auth-code-xyz',
        'https://auth.example.com'
      )

      expect(result).toMatchObject({ success: true, mcpId: 'mcp-1' })
    })

    it('sends scopes_supported from the resource metadata when DCR returns no scope (Robinhood case)', async () => {
      // Probe: 401 with resource_metadata
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/res"',
          },
        })
      )
      // Resource metadata advertises the scope (like Robinhood's ["internal"])
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com',
            authorization_servers: ['https://auth.example.com'],
            scopes_supported: ['internal'],
          }),
          { status: 200 }
        )
      )
      // Auth server metadata: registration endpoint present, no scopes_supported
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
          }),
          { status: 200 }
        )
      )
      // DCR response echoes no `scope` (exactly what Robinhood returns)
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ client_id: 'dyn-client-id' }),
          { status: 200 }
        )
      )

      // DB: new server has no stored client credentials yet
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([{ oauthClientId: null, oauthClientSecret: null }])
      mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })

      const result = await initiateOAuthFlow(
        'mcp-1',
        'https://mcp.example.com/mcp',
        ['http://localhost:3000/callback']
      )

      expect(result).not.toBeNull()
      const url = new URL(result!.authorizationUrl)
      // Without this the AS bounces the user back with no consent screen.
      expect(url.searchParams.get('scope')).toBe('internal')
    })

    it('prefers the scope challenged in WWW-Authenticate over scopes_supported', async () => {
      // Probe: 401 whose WWW-Authenticate names a required scope (RFC 6750 §3).
      // Per the MCP auth spec this is priority #1, ahead of scopes_supported.
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/res", scope="files:read files:write"',
          },
        })
      )
      // Resource metadata advertises a *different* scopes_supported set
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com',
            authorization_servers: ['https://auth.example.com'],
            scopes_supported: ['read', 'write'],
          }),
          { status: 200 }
        )
      )
      // Auth server metadata
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
          }),
          { status: 200 }
        )
      )

      // DB: existing server with a stored client id (no fresh registration)
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([{ oauthClientId: 'existing-client-id', oauthClientSecret: null }])
      mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })

      const result = await initiateOAuthFlow(
        'mcp-1',
        'https://mcp.example.com/mcp',
        ['http://localhost:3000/callback']
      )

      expect(result).not.toBeNull()
      const url = new URL(result!.authorizationUrl)
      // The challenged scope wins over scopes_supported ('read write').
      expect(url.searchParams.get('scope')).toBe('files:read files:write')
    })

    it('returns null when discovery fails', async () => {
      // Probe: 200 — no auth
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      )

      const result = await initiateOAuthFlow(
        'mcp-1',
        'https://mcp.example.com/mcp',
        ['http://localhost:3000/callback']
      )
      expect(result).toBeNull()
    })

    it('uses provided clientId/clientSecret over stored credentials and skips dynamic registration', async () => {
      setupDiscoveryMocks()

      // DB: existing server has different stored credentials
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        { oauthClientId: 'stored-client-id', oauthClientSecret: 'stored-secret' },
      ])
      mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })

      const fetchCallCountBefore = mockFetch.mock.calls.length

      const result = await initiateOAuthFlow(
        'mcp-1',
        'https://mcp.example.com/mcp',
        ['http://localhost:3000/callback'],
        false,
        undefined,
        'override-client-id',
        'override-client-secret'
      )

      expect(result).not.toBeNull()
      const url = new URL(result!.authorizationUrl)
      expect(url.searchParams.get('client_id')).toBe('override-client-id')

      // Verify no dynamic registration call was issued (only the 3 discovery fetches)
      expect(mockFetch.mock.calls.length).toBe(fetchCallCountBefore + 3)

      // Verify the override credentials get persisted to the DB record
      const updateArgs = mockSet.mock.calls[mockSet.mock.calls.length - 1][0]
      expect(updateArgs.oauthClientId).toBe('override-client-id')
      expect(updateArgs.oauthClientSecret).toBe('override-client-secret')
    })

    it('returns null when S256 is not supported and methods are specified', async () => {
      // Probe: 401
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer' },
        })
      )
      // Well-known: metadata with only 'plain' supported
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            code_challenge_methods_supported: ['plain'],
          }),
          { status: 200 }
        )
      )

      // DB: existing server
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        { oauthClientId: 'client-id' },
      ])

      await expect(
        initiateOAuthFlow(
          'mcp-1',
          'https://mcp.example.com/mcp',
          ['http://localhost:3000/callback']
        )
      ).rejects.toThrow('does not support the required S256 PKCE method')
    })

    it('throws a setup error when no client_id is available', async () => {
      setupDiscoveryMocks()

      // DB: no existing oauthClientId, no registration endpoint in metadata
      // (no registration_endpoint in the mock above, so it won't try dynamic registration)
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        { oauthClientId: null, oauthClientSecret: null },
      ])

      await expect(
        initiateOAuthFlow(
          'mcp-1',
          'https://mcp.example.com/mcp',
          ['http://localhost:3000/callback']
        )
      ).rejects.toThrow('does not support automatic client registration')
    })

    it('falls back to the stored client when dynamic registration is rejected', async () => {
      // Probe: 401
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer' },
        })
      )
      // Well-known: metadata WITH a registration endpoint
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
          }),
          { status: 200 }
        )
      )
      // Registration: rejected
      mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))

      // DB: existing server has stored credentials from a prior registration
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        { oauthClientId: 'stored-client-id', oauthClientSecret: 'stored-secret' },
      ])
      mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })

      const result = await initiateOAuthFlow(
        'mcp-1',
        'https://mcp.example.com/mcp',
        ['http://localhost:3000/callback']
      )

      expect(result).not.toBeNull()
      const url = new URL(result!.authorizationUrl)
      expect(url.searchParams.get('client_id')).toBe('stored-client-id')
    })
  })

  // =========================================================================
  // initiateNewServerOAuth — authorization URL for new servers
  // =========================================================================
  describe('initiateNewServerOAuth', () => {
    it('constructs authorization URL via dynamic client registration', async () => {
      // Discovery: 401 + resource_metadata
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/res"',
          },
        })
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com',
            authorization_servers: ['https://auth.example.com'],
          }),
          { status: 200 }
        )
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
          }),
          { status: 200 }
        )
      )
      // Dynamic client registration (server returns scope)
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ client_id: 'dyn-client-abc', scope: 'mcp:read mcp:write' }),
          { status: 200 }
        )
      )

      const result = await initiateNewServerOAuth(
        'https://mcp.example.com/mcp',
        'New MCP',
        ['http://localhost/callback'],
        false,
        'user-1'
      )

      expect(result).not.toBeNull()
      const url = new URL(result!.authorizationUrl)
      expect(url.searchParams.get('client_id')).toBe('dyn-client-abc')
      expect(url.searchParams.get('response_type')).toBe('code')
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost/callback'
      )
      // Scope from registration response is included in authorize URL
      expect(url.searchParams.get('scope')).toBe('mcp:read mcp:write')
      expect(result!.state).toBeTruthy()
      expect(result!.state).toHaveLength(32) // 16 bytes hex
    })

    // Discovery mocks (probe → resource metadata → auth-server metadata with a
    // registration endpoint) shared by the redirect-candidate fallback tests.
    function setupNewServerDcrDiscovery() {
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/res"',
          },
        })
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com',
            authorization_servers: ['https://auth.example.com'],
          }),
          { status: 200 }
        )
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
          }),
          { status: 200 }
        )
      )
    }

    it('falls back to the http loopback redirect when DCR rejects the custom app scheme (cal.com case)', async () => {
      setupNewServerDcrDiscovery()
      // DCR #1: custom scheme rejected — cal.com allows only http(s) redirects.
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'invalid_request',
            error_description: 'Invalid redirect_uri: invalid scheme: superagent:',
          }),
          { status: 400 }
        )
      )
      // DCR #2: http loopback redirect accepted.
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ client_id: 'dyn-loopback' }), { status: 201 })
      )

      const loopback = 'http://localhost:47891/api/remote-mcps/oauth-callback'
      const result = await initiateNewServerOAuth(
        'https://mcp.example.com/mcp',
        'Cal.com',
        ['superagent://mcp-oauth-callback', loopback],
        true,
        'user-1'
      )

      expect(result).not.toBeNull()
      const url = new URL(result!.authorizationUrl)
      // The authorization request must use the redirect the AS actually accepted.
      expect(url.searchParams.get('redirect_uri')).toBe(loopback)
      expect(url.searchParams.get('client_id')).toBe('dyn-loopback')

      // Registration was attempted with the custom scheme first, then the loopback.
      const registerCalls = mockFetch.mock.calls.filter(
        ([reqUrl]) => reqUrl === 'https://auth.example.com/register'
      )
      expect(registerCalls).toHaveLength(2)
      expect(JSON.parse(registerCalls[0][1].body).redirect_uris).toEqual([
        'superagent://mcp-oauth-callback',
      ])
      expect(JSON.parse(registerCalls[1][1].body).redirect_uris).toEqual([loopback])
    })

    it('propagates the last rejection reason when DCR rejects every redirect candidate', async () => {
      setupNewServerDcrDiscovery()
      // DCR #1: custom scheme rejected.
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'invalid_client_metadata',
            error_description: 'redirect_uri is not allowed by the account configuration',
          }),
          { status: 400 }
        )
      )
      // DCR #2: loopback rejected too.
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'invalid_client_metadata',
            error_description: 'redirect_uri is not allowed by the account configuration',
          }),
          { status: 400 }
        )
      )

      await expect(
        initiateNewServerOAuth(
          'https://mcp.example.com/mcp',
          'Locked Down',
          ['superagent://mcp-oauth-callback', 'http://localhost:47891/api/remote-mcps/oauth-callback'],
          true,
          'user-1'
        )
      ).rejects.toThrow(
        'The authorization server rejected client registration (HTTP 400): invalid_client_metadata: redirect_uri is not allowed by the account configuration'
      )
    })

    it('uses the preferred (custom scheme) redirect when DCR accepts it', async () => {
      setupNewServerDcrDiscovery()
      // DCR #1: custom scheme accepted — no fallback needed.
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ client_id: 'dyn-scheme' }), { status: 201 })
      )

      const result = await initiateNewServerOAuth(
        'https://mcp.example.com/mcp',
        'Scheme OK',
        ['superagent://mcp-oauth-callback', 'http://localhost:47891/api/remote-mcps/oauth-callback'],
        true,
        'user-1'
      )

      expect(result).not.toBeNull()
      const url = new URL(result!.authorizationUrl)
      expect(url.searchParams.get('redirect_uri')).toBe('superagent://mcp-oauth-callback')
      expect(url.searchParams.get('client_id')).toBe('dyn-scheme')
      // Only one registration attempt was made (the loopback was never tried).
      const registerCalls = mockFetch.mock.calls.filter(
        ([reqUrl]) => reqUrl === 'https://auth.example.com/register'
      )
      expect(registerCalls).toHaveLength(1)
    })

    it('uses provided clientId/clientSecret without dynamic registration', async () => {
      // Discovery succeeds but registration_endpoint is not used.
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer' },
        })
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
          }),
          { status: 200 }
        )
      )

      const result = await initiateNewServerOAuth(
        'https://mcp.example.com/mcp',
        'New MCP',
        ['http://localhost/callback'],
        false,
        'user-1',
        undefined,
        'byo-client-id',
        'byo-client-secret'
      )

      expect(result).not.toBeNull()
      const url = new URL(result!.authorizationUrl)
      expect(url.searchParams.get('client_id')).toBe('byo-client-id')
      // No registration request should have been made
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('succeeds with provided clientId even when registration_endpoint is absent', async () => {
      // Mirrors the Meta case: server has no usable dynamic registration.
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer' },
        })
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
          }),
          { status: 200 }
        )
      )

      const result = await initiateNewServerOAuth(
        'https://mcp.example.com/mcp',
        'New MCP',
        ['http://localhost/callback'],
        false,
        'user-1',
        undefined,
        'manual-client-id'
      )

      expect(result).not.toBeNull()
      const url = new URL(result!.authorizationUrl)
      expect(url.searchParams.get('client_id')).toBe('manual-client-id')
    })

    it('throws a setup error when dynamic registration is not available', async () => {
      // Discovery without registration_endpoint
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer' },
        })
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            // no registration_endpoint
          }),
          { status: 200 }
        )
      )

      await expect(
        initiateNewServerOAuth(
          'https://mcp.example.com/mcp',
          'New MCP',
          ['http://localhost/callback']
        )
      ).rejects.toThrow('does not support automatic client registration')
    })
  })

  // =========================================================================
  // completeOAuthFlow — token exchange
  // =========================================================================
  describe('completeOAuthFlow', () => {
    // We need to first initiate a flow to populate the pendingOAuthFlows map,
    // then complete it. We'll use initiateNewServerOAuth to set up state.

    async function setupFlowAndGetState(options: {
      issuer?: string
      supportsIss?: boolean
    } = {}): Promise<string> {
      // Full discovery + registration
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/res"',
          },
        })
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com',
            authorization_servers: ['https://auth.example.com'],
          }),
          { status: 200 }
        )
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
            ...(options.issuer ? { issuer: options.issuer } : {}),
            ...(options.supportsIss === undefined
              ? {}
              : { authorization_response_iss_parameter_supported: options.supportsIss }),
          }),
          { status: 200 }
        )
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ client_id: 'dyn-client' }),
          { status: 200 }
        )
      )

      const result = await initiateNewServerOAuth(
        'https://mcp.example.com/mcp',
        'Test Server',
        ['http://localhost/callback'],
        false,
        'user-1'
      )
      return result!.state
    }

    it('exchanges code for tokens and creates new server record', async () => {
      const state = await setupFlowAndGetState()

      // Token exchange response
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-tok-123',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'refresh-tok-456',
          }),
          { status: 200 }
        )
      )

      // DB insert for new server
      mockInsertValues.mockResolvedValue(undefined)

      const result = await completeOAuthFlow(state, 'auth-code-xyz')

      expect(result.success).toBe(true)
      expect(result.mcpId).toBeTruthy()

      // Verify token exchange was called correctly
      const tokenCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]
      expect(tokenCall[0]).toBe('https://auth.example.com/token')
      expect(tokenCall[1].method).toBe('POST')
      expect(tokenCall[1].headers['Content-Type']).toBe(
        'application/x-www-form-urlencoded'
      )
      const body = new URLSearchParams(tokenCall[1].body.toString())
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code')).toBe('auth-code-xyz')
      expect(body.get('redirect_uri')).toBe('http://localhost/callback')
    })

    it('reports electron + custom-scheme delivery flags so the callback can hand back to the app', async () => {
      // Electron flow whose DCR accepts the custom app scheme on the first try.
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/res"',
          },
        })
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com',
            authorization_servers: ['https://auth.example.com'],
          }),
          { status: 200 }
        )
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
          }),
          { status: 200 }
        )
      )
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ client_id: 'dyn-scheme' }), { status: 201 })
      )

      const initiated = await initiateNewServerOAuth(
        'https://mcp.example.com/mcp',
        'Scheme Electron',
        ['superagent://mcp-oauth-callback', 'http://localhost:47891/api/remote-mcps/oauth-callback'],
        true,
        'user-1'
      )
      expect(initiated).not.toBeNull()

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'access-tok', token_type: 'Bearer' }),
          { status: 200 }
        )
      )
      mockInsertValues.mockResolvedValue(undefined)

      const result = await completeOAuthFlow(initiated!.state, 'auth-code')

      expect(result.success).toBe(true)
      expect(result.electron).toBe(true)
      // The custom app scheme won registration, so the callback route keeps the
      // main-process-parsed HTML rather than the external-browser hand-off.
      expect(result.redirectWasScheme).toBe(true)
    })

    it('reports a non-scheme (loopback) redirect so the callback hands back via the external browser', async () => {
      // Electron flow whose DCR rejects the scheme and falls back to loopback.
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/res"',
          },
        })
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: 'https://mcp.example.com',
            authorization_servers: ['https://auth.example.com'],
          }),
          { status: 200 }
        )
      )
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
          }),
          { status: 200 }
        )
      )
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 400 }))
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ client_id: 'dyn-loopback' }), { status: 201 })
      )

      const initiated = await initiateNewServerOAuth(
        'https://mcp.example.com/mcp',
        'Loopback Electron',
        ['superagent://mcp-oauth-callback', 'http://localhost:47891/api/remote-mcps/oauth-callback'],
        true,
        'user-1'
      )
      expect(initiated).not.toBeNull()

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'access-tok', token_type: 'Bearer' }),
          { status: 200 }
        )
      )
      mockInsertValues.mockResolvedValue(undefined)

      const result = await completeOAuthFlow(initiated!.state, 'auth-code')

      expect(result.success).toBe(true)
      expect(result.electron).toBe(true)
      expect(result.redirectWasScheme).toBe(false)
    })

    it('stores issuer metadata and accepts a matching iss when advertised as supported', async () => {
      const state = await setupFlowAndGetState({
        issuer: 'https://auth.example.com',
        supportsIss: true,
      })

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-tok-123',
            token_type: 'Bearer',
          }),
          { status: 200 }
        )
      )
      mockInsertValues.mockResolvedValue(undefined)

      const result = await completeOAuthFlow(
        state,
        'auth-code-xyz',
        'https://auth.example.com'
      )

      expect(result.success).toBe(true)
      expect(mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]).toBe(
        'https://auth.example.com/token'
      )
    })

    it('rejects a missing iss before token exchange when metadata advertises support', async () => {
      const state = await setupFlowAndGetState({
        issuer: 'https://auth.example.com',
        supportsIss: true,
      })
      const fetchCallsBefore = mockFetch.mock.calls.length

      const result = await completeOAuthFlow(state, 'auth-code-xyz')

      expect(result.success).toBe(false)
      expect(mockFetch).toHaveBeenCalledTimes(fetchCallsBefore)
      expect(mockInsertValues).not.toHaveBeenCalled()
      expect(
        validateAndConsumeOAuthErrorResponse(state, 'https://auth.example.com').valid
      ).toBe(true)
    })

    it('rejects a mismatched iss before token exchange when metadata advertises support', async () => {
      const state = await setupFlowAndGetState({
        issuer: 'https://auth.example.com',
        supportsIss: true,
      })
      const fetchCallsBefore = mockFetch.mock.calls.length

      const result = await completeOAuthFlow(
        state,
        'auth-code-xyz',
        'https://evil.example.com'
      )

      expect(result.success).toBe(false)
      expect(mockFetch).toHaveBeenCalledTimes(fetchCallsBefore)
      expect(mockInsertValues).not.toHaveBeenCalled()
      expect(
        validateAndConsumeOAuthErrorResponse(state, 'https://auth.example.com').valid
      ).toBe(true)
    })

    it('compares iss with simple string comparison without URI normalization', async () => {
      const state = await setupFlowAndGetState({
        issuer: 'https://auth.example.com',
        supportsIss: true,
      })
      const fetchCallsBefore = mockFetch.mock.calls.length

      const result = await completeOAuthFlow(
        state,
        'auth-code-xyz',
        'https://AUTH.example.com/'
      )

      expect(result.success).toBe(false)
      expect(mockFetch).toHaveBeenCalledTimes(fetchCallsBefore)
      expect(
        validateAndConsumeOAuthErrorResponse(state, 'https://auth.example.com').valid
      ).toBe(true)
    })

    it('accepts a matching iss even when metadata does not advertise support', async () => {
      const state = await setupFlowAndGetState({
        issuer: 'https://auth.example.com',
        supportsIss: false,
      })

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-tok-123',
            token_type: 'Bearer',
          }),
          { status: 200 }
        )
      )
      mockInsertValues.mockResolvedValue(undefined)

      const result = await completeOAuthFlow(
        state,
        'auth-code-xyz',
        'https://auth.example.com'
      )

      expect(result.success).toBe(true)
    })

    it('compares a present iss when the support flag is absent', async () => {
      const state = await setupFlowAndGetState({
        issuer: 'https://auth.example.com',
      })
      const fetchCallsBefore = mockFetch.mock.calls.length

      const result = await completeOAuthFlow(
        state,
        'auth-code-xyz',
        'https://evil.example.com'
      )

      expect(result.success).toBe(false)
      expect(mockFetch).toHaveBeenCalledTimes(fetchCallsBefore)
      expect(
        validateAndConsumeOAuthErrorResponse(state, 'https://auth.example.com').valid
      ).toBe(true)
    })

    it('rejects a mismatched iss even when metadata does not advertise support', async () => {
      const state = await setupFlowAndGetState({
        issuer: 'https://auth.example.com',
        supportsIss: false,
      })
      const fetchCallsBefore = mockFetch.mock.calls.length

      const result = await completeOAuthFlow(
        state,
        'auth-code-xyz',
        'https://evil.example.com'
      )

      expect(result.success).toBe(false)
      expect(mockFetch).toHaveBeenCalledTimes(fetchCallsBefore)
      expect(
        validateAndConsumeOAuthErrorResponse(state, 'https://auth.example.com').valid
      ).toBe(true)
    })

    it('does not consume a pending flow when issuer validation fails', async () => {
      const state = await setupFlowAndGetState({
        issuer: 'https://auth.example.com',
        supportsIss: true,
      })

      const invalid = await completeOAuthFlow(
        state,
        'auth-code-xyz',
        'https://evil.example.com'
      )
      expect(invalid.success).toBe(false)

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-tok-123',
            token_type: 'Bearer',
          }),
          { status: 200 }
        )
      )
      mockInsertValues.mockResolvedValue(undefined)

      const valid = await completeOAuthFlow(
        state,
        'auth-code-xyz',
        'https://auth.example.com'
      )
      expect(valid.success).toBe(true)
    })

    it('validates and consumes trusted authorization error responses', async () => {
      const state = await setupFlowAndGetState({
        issuer: 'https://auth.example.com',
        supportsIss: true,
      })

      const validation = validateAndConsumeOAuthErrorResponse(
        state,
        'https://auth.example.com'
      )

      expect(validation.valid).toBe(true)

      const result = await completeOAuthFlow(
        state,
        'auth-code-xyz',
        'https://auth.example.com'
      )
      expect(result.success).toBe(false)
    })

    it('rejects untrusted authorization error responses without consuming the pending flow', async () => {
      const state = await setupFlowAndGetState({
        issuer: 'https://auth.example.com',
        supportsIss: true,
      })

      const validation = validateAndConsumeOAuthErrorResponse(
        state,
        'https://evil.example.com'
      )

      expect(validation.valid).toBe(false)

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-tok-123',
            token_type: 'Bearer',
          }),
          { status: 200 }
        )
      )
      mockInsertValues.mockResolvedValue(undefined)

      const result = await completeOAuthFlow(
        state,
        'auth-code-xyz',
        'https://auth.example.com'
      )
      expect(result.success).toBe(true)
    })

    it('calculates expiry correctly from expires_in', async () => {
      const state = await setupFlowAndGetState()

      const before = Date.now()

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'tok',
            token_type: 'Bearer',
            expires_in: 7200,
          }),
          { status: 200 }
        )
      )
      mockInsertValues.mockResolvedValue(undefined)

      await completeOAuthFlow(state, 'code-123')

      const after = Date.now()

      // Verify the insert call included correct tokenExpiresAt
      const insertCall = mockInsertValues.mock.calls[0][0]
      const expiryMs = insertCall.tokenExpiresAt.getTime()
      // The expiry should be approximately now + 7200s, within the test execution window
      expect(expiryMs).toBeGreaterThanOrEqual(before + 7200 * 1000)
      expect(expiryMs).toBeLessThanOrEqual(after + 7200 * 1000)
    })

    it('returns success: false for unknown state', async () => {
      const result = await completeOAuthFlow('unknown-state', 'code')
      expect(result.success).toBe(false)
      expect(result.mcpId).toBeUndefined()
    })

    it('returns success: false when token exchange HTTP request fails', async () => {
      const state = await setupFlowAndGetState()

      mockFetch.mockResolvedValueOnce(
        new Response('{"error":"invalid_grant"}', { status: 400 })
      )

      const result = await completeOAuthFlow(state, 'bad-code')
      expect(result.success).toBe(false)
    })

    it('cleans up pending flow even on success', async () => {
      const state = await setupFlowAndGetState()

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'tok',
            token_type: 'Bearer',
          }),
          { status: 200 }
        )
      )
      mockInsertValues.mockResolvedValue(undefined)

      await completeOAuthFlow(state, 'code-1')

      // Second call with same state should fail (flow removed)
      const result = await completeOAuthFlow(state, 'code-2')
      expect(result.success).toBe(false)
    })
  })

  // =========================================================================
  // refreshMcpToken
  // =========================================================================
  describe('refreshMcpToken', () => {
    it('refreshes token and returns new access_token', async () => {
      // DB: existing server with refresh token
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        {
          id: 'mcp-1',
          refreshToken: 'old-refresh-tok',
          oauthTokenEndpoint: 'https://auth.example.com/token',
          oauthClientId: 'client-123',
          oauthClientSecret: 'secret-456',
          oauthResource: 'https://mcp.example.com',
        },
      ])

      // Token refresh response
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'new-access-tok',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'new-refresh-tok',
          }),
          { status: 200 }
        )
      )

      // DB update
      mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })

      const newToken = await refreshMcpToken('mcp-1')
      expect(newToken).toBe('new-access-tok')

      // Verify the refresh request included client_secret and resource
      const fetchCall = mockFetch.mock.calls[0]
      const body = new URLSearchParams(fetchCall[1].body.toString())
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('old-refresh-tok')
      expect(body.get('client_id')).toBe('client-123')
      expect(body.get('client_secret')).toBe('secret-456')
      expect(body.get('resource')).toBe('https://mcp.example.com')
    })

    it('omits client_secret and resource when not present', async () => {
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        {
          id: 'mcp-2',
          refreshToken: 'refresh-tok',
          oauthTokenEndpoint: 'https://auth.example.com/token',
          oauthClientId: 'client-id',
          oauthClientSecret: null,
          oauthResource: null,
        },
      ])

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'refreshed-tok',
            token_type: 'Bearer',
          }),
          { status: 200 }
        )
      )

      mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })

      const newToken = await refreshMcpToken('mcp-2')
      expect(newToken).toBe('refreshed-tok')

      const body = new URLSearchParams(
        mockFetch.mock.calls[0][1].body.toString()
      )
      expect(body.has('client_secret')).toBe(false)
      expect(body.has('resource')).toBe(false)
    })

    it('preserves old refresh_token when new one is not provided', async () => {
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        {
          id: 'mcp-3',
          refreshToken: 'keep-this-refresh',
          oauthTokenEndpoint: 'https://auth.example.com/token',
          oauthClientId: 'client-id',
          oauthClientSecret: null,
          oauthResource: null,
        },
      ])

      // Response without refresh_token
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            token_type: 'Bearer',
          }),
          { status: 200 }
        )
      )

      const mockUpdateWhere = vi.fn().mockResolvedValue(undefined)
      mockSet.mockReturnValue({ where: mockUpdateWhere })

      await refreshMcpToken('mcp-3')

      // Verify the DB update preserved the old refresh token
      const updateArgs = mockSet.mock.calls[0][0]
      expect(updateArgs.refreshToken).toBe('keep-this-refresh')
    })

    it('returns null when server has no refresh token', async () => {
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        {
          id: 'mcp-4',
          refreshToken: null,
          oauthTokenEndpoint: 'https://auth.example.com/token',
          oauthClientId: 'client-id',
        },
      ])

      const result = await refreshMcpToken('mcp-4')
      expect(result).toBeNull()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('returns null when server is not found', async () => {
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([])

      const result = await refreshMcpToken('nonexistent')
      expect(result).toBeNull()
    })

    it('returns null when token refresh HTTP request fails', async () => {
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        {
          id: 'mcp-5',
          refreshToken: 'expired-refresh',
          oauthTokenEndpoint: 'https://auth.example.com/token',
          oauthClientId: 'client-id',
          oauthClientSecret: null,
          oauthResource: null,
        },
      ])

      mockFetch.mockResolvedValueOnce(
        new Response('{"error":"invalid_grant"}', { status: 400 })
      )

      const result = await refreshMcpToken('mcp-5')
      expect(result).toBeNull()
    })
  })
})

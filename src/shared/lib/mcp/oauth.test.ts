import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock DB with chainable query builder
const mockLimit = vi.fn()
const mockWhere = vi.fn()
const mockSet = vi.fn()
const mockDbFrom = vi.fn()
const mockInsertValues = vi.fn()

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

// Must import after mocks
import {
  discoverOAuthMetadata,
  registerDynamicClient,
  initiateOAuthFlow,
  initiateNewServerOAuth,
  completeOAuthFlow,
  refreshMcpToken,
} from './oauth'

describe('oauth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
        'http://localhost:3000/callback',
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
        'Superagent'
      )
      expect(result).toEqual({
        clientId: 'new-client-id',
        clientSecret: 'new-secret',
        scope: 'mcp:read mcp:write',
      })
    })

    it('returns null on registration failure', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 400 }))

      const result = await registerDynamicClient(
        'https://auth.example.com/register',
        'http://localhost/callback',
        'Superagent'
      )
      expect(result).toBeNull()
    })

    it('returns null on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const result = await registerDynamicClient(
        'https://auth.example.com/register',
        'http://localhost/callback',
        'Superagent'
      )
      expect(result).toBeNull()
    })
  })

  // =========================================================================
  // initiateOAuthFlow — authorization URL construction
  // =========================================================================
  describe('initiateOAuthFlow', () => {
    function setupDiscoveryMocks() {
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
        'http://localhost:3000/callback'
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
      expect(url.searchParams.has('resource')).toBe(false)
      // No scope when using existing client (scope only from fresh registration)
      expect(url.searchParams.has('scope')).toBe(false)
    })

    it('returns null when discovery fails', async () => {
      // Probe: 200 — no auth
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      )

      const result = await initiateOAuthFlow(
        'mcp-1',
        'https://mcp.example.com/mcp',
        'http://localhost:3000/callback'
      )
      expect(result).toBeNull()
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

      const result = await initiateOAuthFlow(
        'mcp-1',
        'https://mcp.example.com/mcp',
        'http://localhost:3000/callback'
      )
      expect(result).toBeNull()
    })

    it('returns null when no client_id is available', async () => {
      setupDiscoveryMocks()

      // DB: no existing oauthClientId, no registration endpoint in metadata
      // (no registration_endpoint in the mock above, so it won't try dynamic registration)
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        { oauthClientId: null, oauthClientSecret: null },
      ])

      const result = await initiateOAuthFlow(
        'mcp-1',
        'https://mcp.example.com/mcp',
        'http://localhost:3000/callback'
      )
      expect(result).toBeNull()
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
        'http://localhost/callback',
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

    it('returns null when dynamic registration is not available', async () => {
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

      const result = await initiateNewServerOAuth(
        'https://mcp.example.com/mcp',
        'New MCP',
        'http://localhost/callback'
      )
      expect(result).toBeNull()
    })
  })

  // =========================================================================
  // completeOAuthFlow — token exchange
  // =========================================================================
  describe('completeOAuthFlow', () => {
    // We need to first initiate a flow to populate the pendingOAuthFlows map,
    // then complete it. We'll use initiateNewServerOAuth to set up state.

    async function setupFlowAndGetState(): Promise<string> {
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
        'http://localhost/callback',
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

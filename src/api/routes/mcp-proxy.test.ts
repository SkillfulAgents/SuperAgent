import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------
const mockValidateProxyToken = vi.fn()

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...args: unknown[]) => mockValidateProxyToken(...args),
}))

// Mock DB with chainable query builder
const mockLimit = vi.fn()
const mockWhere = vi.fn()
const mockInnerJoin = vi.fn()
const mockDbFrom = vi.fn()
const mockInsertValues = vi.fn()
const mockUpdateSet = vi.fn()
const mockUpdateWhere = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: mockDbFrom }),
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: mockUpdateSet }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  remoteMcpServers: { id: 'id' },
  agentRemoteMcps: {
    agentSlug: 'agent_slug',
    remoteMcpId: 'remote_mcp_id',
  },
  mcpAuditLog: {},
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  and: (...args: unknown[]) => args,
}))

// Mock fetch for forwarded requests
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import mcpProxy from './mcp-proxy'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp() {
  const app = new Hono()
  app.route('/api/mcp-proxy', mcpProxy)
  return app
}

/** Build a realistic MCP server record */
function buildMcp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mcp-1',
    name: 'Test MCP',
    url: 'https://mcp.example.com',
    authType: 'oauth' as const,
    accessToken: 'access-tok-123',
    refreshToken: 'refresh-tok-456',
    tokenExpiresAt: new Date(Date.now() + 3_600_000), // 1h from now
    oauthTokenEndpoint: 'https://auth.example.com/token',
    oauthClientId: 'client-id-abc',
    oauthClientSecret: 'client-secret-xyz',
    oauthResource: null,
    status: 'active',
    errorMessage: null,
    ...overrides,
  }
}

/** Wire up all DB mocks so the handler reaches the proxy step */
function setupDbMocks(mcp: ReturnType<typeof buildMcp>) {
  mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
  mockInnerJoin.mockReturnValue({ where: mockWhere })
  mockWhere.mockReturnValue({ limit: mockLimit })
  mockLimit.mockResolvedValue([{ mcp }])
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere })
  mockUpdateWhere.mockReturnValue({ catch: () => Promise.resolve() })
}

/** Full success‐path wiring: valid token, DB lookup, upstream OK */
function setupSuccessPath(
  overrides: {
    mcpOverrides?: Record<string, unknown>
    upstreamStatus?: number
    upstreamHeaders?: Record<string, string>
    upstreamBody?: string
  } = {}
) {
  const {
    mcpOverrides = {},
    upstreamStatus = 200,
    upstreamHeaders = { 'content-type': 'application/json' },
    upstreamBody = '{"ok":true}',
  } = overrides

  mockValidateProxyToken.mockResolvedValue('my-agent')
  const mcp = buildMcp(mcpOverrides)
  setupDbMocks(mcp)

  const mockResponse = new Response(upstreamBody, {
    status: upstreamStatus,
    headers: upstreamHeaders,
  })
  mockFetch.mockResolvedValue(mockResponse)
  return mcp
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('mcp-proxy route', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    // Default: DB writes succeed
    mockInsertValues.mockResolvedValue(undefined)
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere })
    mockUpdateWhere.mockReturnValue({ catch: () => Promise.resolve() })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function makeRequest(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, options)
  }

  // =========================================================================
  // 1. Token validation and agent matching
  // =========================================================================
  describe('token validation and agent matching', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/some/path')
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toContain('Authorization')
    })

    it('returns 401 when Authorization header does not start with Bearer', async () => {
      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/some/path', {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toContain('Authorization')
    })

    it('returns 401 when proxy token is invalid', async () => {
      mockValidateProxyToken.mockResolvedValue(null)

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_invalid' },
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toContain('Invalid proxy token')
      expect(mockValidateProxyToken).toHaveBeenCalledWith('synth_invalid')
    })

    it('returns 403 when token belongs to a different agent', async () => {
      mockValidateProxyToken.mockResolvedValue('other-agent')

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_other' },
      })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain('does not match')
    })

    it('accepts a valid token that matches the agent slug', async () => {
      setupSuccessPath()

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })
      expect(res.status).toBe(200)
    })
  })

  // =========================================================================
  // 2. Agent → MCP mapping lookup
  // =========================================================================
  describe('agent-MCP mapping', () => {
    it('returns 404 when MCP server is not assigned to the agent', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
      mockInnerJoin.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([]) // no mapping found

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain('not found')
    })
  })

  // =========================================================================
  // 3. Token refresh logic (tryRefreshToken)
  // =========================================================================
  describe('token refresh for expired tokens', () => {
    it('refreshes an expired token and uses the new access token', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 60_000), // expired 1 minute ago
      })
      setupDbMocks(mcp)

      // Mock the refresh fetch call
      const refreshResponse = new Response(
        JSON.stringify({
          access_token: 'new-access-tok',
          refresh_token: 'new-refresh-tok',
          expires_in: 3600,
        }),
        { status: 200 }
      )
      // First fetch call = token refresh, second = the actual proxy request
      mockFetch
        .mockResolvedValueOnce(refreshResponse)
        .mockResolvedValueOnce(
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })
      expect(res.status).toBe(200)

      // Verify the refresh call was made correctly
      expect(mockFetch).toHaveBeenCalledTimes(2)
      const [refreshUrl, refreshInit] = mockFetch.mock.calls[0]
      expect(refreshUrl).toBe('https://auth.example.com/token')
      expect(refreshInit.method).toBe('POST')
      const refreshBody = refreshInit.body as URLSearchParams
      expect(refreshBody.get('grant_type')).toBe('refresh_token')
      expect(refreshBody.get('refresh_token')).toBe('refresh-tok-456')
      expect(refreshBody.get('client_id')).toBe('client-id-abc')
      expect(refreshBody.get('client_secret')).toBe('client-secret-xyz')

      // Verify the proxy request used the new token
      const [, proxyInit] = mockFetch.mock.calls[1]
      const proxyHeaders = proxyInit.headers as Headers
      expect(proxyHeaders.get('Authorization')).toBe('Bearer new-access-tok')

      // Verify DB was updated with new token
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'new-access-tok',
          refreshToken: 'new-refresh-tok',
          status: 'active',
          errorMessage: null,
        })
      )
    })

    it('includes client_secret in refresh body when present', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 1000),
        oauthClientSecret: 'my-secret',
      })
      setupDbMocks(mcp)

      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: 'refreshed', expires_in: 300 }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [, refreshInit] = mockFetch.mock.calls[0]
      const body = refreshInit.body as URLSearchParams
      expect(body.get('client_secret')).toBe('my-secret')
    })

    it('omits client_secret from refresh body when null', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 1000),
        oauthClientSecret: null,
      })
      setupDbMocks(mcp)

      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: 'refreshed', expires_in: 300 }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [, refreshInit] = mockFetch.mock.calls[0]
      const body = refreshInit.body as URLSearchParams
      expect(body.has('client_secret')).toBe(false)
    })

    it('includes resource parameter in refresh body when present', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 1000),
        oauthResource: 'https://resource.example.com',
      })
      setupDbMocks(mcp)

      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: 'refreshed' }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [, refreshInit] = mockFetch.mock.calls[0]
      const body = refreshInit.body as URLSearchParams
      expect(body.get('resource')).toBe('https://resource.example.com')
    })

    it('omits resource parameter from refresh body when null', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 1000),
        oauthResource: null,
      })
      setupDbMocks(mcp)

      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: 'refreshed' }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [, refreshInit] = mockFetch.mock.calls[0]
      const body = refreshInit.body as URLSearchParams
      expect(body.has('resource')).toBe(false)
    })

    it('returns 401 and marks auth_required when token refresh fails', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 60_000), // expired
      })
      setupDbMocks(mcp)

      // Refresh endpoint returns 400 (failure)
      mockFetch.mockResolvedValueOnce(
        new Response('{"error":"invalid_grant"}', { status: 400 })
      )

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toContain('re-authentication')

      // Verify status was updated to auth_required
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'auth_required',
          errorMessage: 'Token refresh failed',
        })
      )
    })

    it('returns 401 when token is expired but no refresh token is available', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 60_000),
        refreshToken: null, // no refresh token
        accessToken: null, // expired, effectively null
      })
      setupDbMocks(mcp)

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toContain('no access token')
    })

    it('skips refresh when token is not expired yet', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() + 3_600_000), // 1h from now
      })
      setupDbMocks(mcp)

      mockFetch.mockResolvedValueOnce(
        new Response('{"ok":true}', { status: 200 })
      )

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })
      expect(res.status).toBe(200)
      // Only one fetch call (the proxy request, not a refresh)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('keeps old refresh token when refresh response does not include a new one', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 1000),
        refreshToken: 'original-refresh-tok',
      })
      setupDbMocks(mcp)

      mockFetch
        .mockResolvedValueOnce(
          new Response(
            // No refresh_token in response
            JSON.stringify({ access_token: 'new-access' }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshToken: 'original-refresh-tok',
        })
      )
    })

    it('calculates tokenExpiresAt from expires_in in refresh response', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 1000),
      })
      setupDbMocks(mcp)

      const beforeRefresh = Date.now()
      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: 'new-access', expires_in: 7200 }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const updateCall = mockUpdateSet.mock.calls[0][0]
      const expiresAt = updateCall.tokenExpiresAt as Date
      expect(expiresAt).toBeInstanceOf(Date)
      // Should be approximately now + 7200s
      const expectedMin = beforeRefresh + 7200 * 1000 - 5000 // 5s tolerance
      const expectedMax = beforeRefresh + 7200 * 1000 + 5000
      expect(expiresAt.getTime()).toBeGreaterThan(expectedMin)
      expect(expiresAt.getTime()).toBeLessThan(expectedMax)
    })

    it('sets tokenExpiresAt to null when expires_in is missing', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 1000),
      })
      setupDbMocks(mcp)

      mockFetch
        .mockResolvedValueOnce(
          new Response(
            // No expires_in field
            JSON.stringify({ access_token: 'new-access' }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const updateCall = mockUpdateSet.mock.calls[0][0]
      expect(updateCall.tokenExpiresAt).toBeNull()
    })

    it('returns null from tryRefreshToken when missing oauthTokenEndpoint', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 1000),
        refreshToken: 'has-refresh',
        oauthTokenEndpoint: null, // missing
        accessToken: null,
      })
      setupDbMocks(mcp)

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })
      // tryRefreshToken returns null -> accessToken still null -> 401
      expect(res.status).toBe(401)
    })

    it('returns null from tryRefreshToken when missing oauthClientId', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 1000),
        refreshToken: 'has-refresh',
        oauthClientId: null, // missing
        accessToken: null,
      })
      setupDbMocks(mcp)

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })
      expect(res.status).toBe(401)
    })

    it('handles fetch error during token refresh gracefully', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 1000),
      })
      setupDbMocks(mcp)

      // Refresh fetch throws a network error
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toContain('re-authentication')
    })

    it('skips token check entirely when authType is none', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        authType: 'none',
        accessToken: null,
        tokenExpiresAt: null,
      })
      setupDbMocks(mcp)

      mockFetch.mockResolvedValueOnce(
        new Response('{"ok":true}', { status: 200 })
      )

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })
      expect(res.status).toBe(200)
      // Only one fetch call — no refresh was attempted
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('does not inject Authorization header when accessToken is null (authType none)', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        authType: 'none',
        accessToken: null,
      })
      setupDbMocks(mcp)

      mockFetch.mockResolvedValueOnce(
        new Response('{"ok":true}', { status: 200 })
      )

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Headers
      expect(headers.has('Authorization')).toBe(false)
    })
  })

  // =========================================================================
  // 4. Header filtering
  // =========================================================================
  describe('request header filtering', () => {
    it('strips host header from forwarded request', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: {
          Authorization: 'Bearer synth_valid',
          Host: 'localhost:3000',
        },
      })

      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Headers
      expect(headers.has('host')).toBe(false)
    })

    it('strips connection header from forwarded request', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: {
          Authorization: 'Bearer synth_valid',
          Connection: 'keep-alive',
        },
      })

      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Headers
      expect(headers.has('connection')).toBe(false)
    })

    it('strips transfer-encoding header from forwarded request', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: {
          Authorization: 'Bearer synth_valid',
          'Transfer-Encoding': 'chunked',
        },
      })

      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Headers
      expect(headers.has('transfer-encoding')).toBe(false)
    })

    it('strips accept-encoding header from forwarded request', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: {
          Authorization: 'Bearer synth_valid',
          'Accept-Encoding': 'gzip, deflate',
        },
      })

      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Headers
      expect(headers.has('accept-encoding')).toBe(false)
    })

    it('strips content-length header from forwarded request', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Length': '42',
        },
      })

      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Headers
      expect(headers.has('content-length')).toBe(false)
    })

    it('strips the original Authorization header (synthetic token) and replaces with real token', async () => {
      setupSuccessPath({ mcpOverrides: { accessToken: 'real-mcp-token' } })

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Headers
      expect(headers.get('Authorization')).toBe('Bearer real-mcp-token')
    })

    it('forwards custom headers like Content-Type and X-Custom-Header', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/json',
          'X-Custom-Header': 'custom-value',
          Accept: 'application/json',
        },
        body: '{}',
      })

      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Headers
      expect(headers.get('Content-Type')).toBe('application/json')
      expect(headers.get('X-Custom-Header')).toBe('custom-value')
      expect(headers.get('Accept')).toBe('application/json')
    })
  })

  describe('response header filtering', () => {
    it('strips transfer-encoding from upstream response', async () => {
      setupSuccessPath({
        upstreamHeaders: {
          'transfer-encoding': 'chunked',
          'content-type': 'application/json',
        },
      })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.headers.get('transfer-encoding')).toBeNull()
    })

    it('strips content-encoding from upstream response', async () => {
      setupSuccessPath({
        upstreamHeaders: {
          'content-encoding': 'gzip',
          'content-type': 'application/json',
        },
      })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.headers.get('content-encoding')).toBeNull()
    })

    it('strips content-length from upstream response', async () => {
      setupSuccessPath({
        upstreamHeaders: {
          'content-length': '123',
          'content-type': 'application/json',
        },
      })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.headers.get('content-length')).toBeNull()
    })

    it('forwards other response headers like x-request-id and content-type', async () => {
      setupSuccessPath({
        upstreamHeaders: {
          'content-type': 'application/json',
          'x-request-id': 'req-abc-123',
          'x-rate-limit-remaining': '50',
          'cache-control': 'no-cache',
        },
      })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.headers.get('content-type')).toBe('application/json')
      expect(res.headers.get('x-request-id')).toBe('req-abc-123')
      expect(res.headers.get('x-rate-limit-remaining')).toBe('50')
      expect(res.headers.get('cache-control')).toBe('no-cache')
    })
  })

  // =========================================================================
  // 5. URL construction
  // =========================================================================
  describe('URL construction', () => {
    it('appends rest path to base URL', async () => {
      setupSuccessPath({ mcpOverrides: { url: 'https://mcp.example.com' } })

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/v1/messages', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://mcp.example.com/v1/messages')
    })

    it('strips trailing slash from base URL before appending path', async () => {
      setupSuccessPath({ mcpOverrides: { url: 'https://mcp.example.com/' } })

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/v1/messages', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://mcp.example.com/v1/messages')
    })

    it('handles base URL without trailing slash and no rest path', async () => {
      setupSuccessPath({ mcpOverrides: { url: 'https://mcp.example.com' } })

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://mcp.example.com')
    })

    it('handles base URL with trailing slash and no rest path', async () => {
      setupSuccessPath({ mcpOverrides: { url: 'https://mcp.example.com/' } })

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://mcp.example.com')
    })

    it('passes through query string', async () => {
      setupSuccessPath({ mcpOverrides: { url: 'https://mcp.example.com' } })

      await makeRequest(
        '/api/mcp-proxy/my-agent/mcp-1/v1/messages?limit=10&offset=5',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      const [url] = mockFetch.mock.calls[0]
      expect(url).toContain('?limit=10&offset=5')
      expect(url).toBe('https://mcp.example.com/v1/messages?limit=10&offset=5')
    })

    it('passes through query string with encoded characters', async () => {
      setupSuccessPath({ mcpOverrides: { url: 'https://mcp.example.com' } })

      await makeRequest(
        '/api/mcp-proxy/my-agent/mcp-1/search?q=hello%20world&type=all',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      const [url] = mockFetch.mock.calls[0]
      expect(url).toContain('?q=hello%20world&type=all')
    })

    it('handles deeply nested paths', async () => {
      setupSuccessPath({ mcpOverrides: { url: 'https://mcp.example.com' } })

      await makeRequest(
        '/api/mcp-proxy/my-agent/mcp-1/a/b/c/d/e/f',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://mcp.example.com/a/b/c/d/e/f')
    })
  })

  // =========================================================================
  // 6. JSON-RPC body parsing for audit logging
  // =========================================================================
  describe('JSON-RPC body parsing for audit logging', () => {
    it('extracts method from valid JSON-RPC body', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1,
        }),
      })

      // Wait for fire-and-forget audit log
      await new Promise((r) => setTimeout(r, 10))

      expect(mockInsertValues).toHaveBeenCalled()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.requestPath).toBe('tools/list')
    })

    it('extracts tool name from tools/call method in JSON-RPC body', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'get_weather' },
          id: 2,
        }),
      })

      await new Promise((r) => setTimeout(r, 10))

      expect(mockInsertValues).toHaveBeenCalled()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.requestPath).toBe('tools/call: get_weather')
    })

    it('uses method only when tools/call has no params.name', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {},
          id: 3,
        }),
      })

      await new Promise((r) => setTimeout(r, 10))

      expect(mockInsertValues).toHaveBeenCalled()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.requestPath).toBe('tools/call')
    })

    it('does not crash on non-JSON body', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/upload', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'text/plain',
        },
        body: 'this is not json',
      })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/upload', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'text/plain',
        },
        body: 'this is not json',
      })

      // Should still succeed (the proxy request itself goes through)
      expect(res.status).toBe(200)
    })

    it('does not crash on empty body', async () => {
      setupSuccessPath()

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/rpc', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/json',
        },
        body: '',
      })

      expect(res.status).toBe(200)
    })

    it('does not crash on malformed JSON body', async () => {
      setupSuccessPath()

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/rpc', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/json',
        },
        body: '{"method": "incomplete...',
      })

      expect(res.status).toBe(200)
    })

    it('uses HTTP path as mcpMethodInfo for GET requests (no body parsing)', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/some/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      await new Promise((r) => setTimeout(r, 10))

      expect(mockInsertValues).toHaveBeenCalled()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.requestPath).toBe('some/path')
    })

    it('uses "/" as default mcpMethodInfo when rest is empty', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      await new Promise((r) => setTimeout(r, 10))

      expect(mockInsertValues).toHaveBeenCalled()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.requestPath).toBe('/')
    })

    it('does not attempt body parsing for HEAD requests', async () => {
      setupSuccessPath()

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/health', {
        method: 'HEAD',
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.status).toBe(200)

      await new Promise((r) => setTimeout(r, 10))

      expect(mockInsertValues).toHaveBeenCalled()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.requestPath).toBe('health')
    })
  })

  // =========================================================================
  // 7. Auto-marking auth_required on 401 responses
  // =========================================================================
  describe('auto-marking auth_required on 401 upstream response', () => {
    it('marks MCP server as auth_required when upstream returns 401', async () => {
      setupSuccessPath({ upstreamStatus: 401, upstreamBody: '{"error":"unauthorized"}' })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.status).toBe(401)

      // Allow fire-and-forget DB update to settle
      await new Promise((r) => setTimeout(r, 10))

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'auth_required',
          errorMessage: 'Remote server returned 401',
        })
      )
    })

    it('does not mark auth_required when upstream returns 200', async () => {
      setupSuccessPath({ upstreamStatus: 200 })

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      await new Promise((r) => setTimeout(r, 10))

      // mockUpdateSet should NOT have been called for status changes
      // (it might have been called from setupSuccessPath initialization)
      const authRequiredCalls = mockUpdateSet.mock.calls.filter(
        (call) => call[0]?.status === 'auth_required'
      )
      expect(authRequiredCalls).toHaveLength(0)
    })

    it('does not mark auth_required when upstream returns 403', async () => {
      setupSuccessPath({ upstreamStatus: 403, upstreamBody: '{"error":"forbidden"}' })

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      await new Promise((r) => setTimeout(r, 10))

      const authRequiredCalls = mockUpdateSet.mock.calls.filter(
        (call) => call[0]?.status === 'auth_required'
      )
      expect(authRequiredCalls).toHaveLength(0)
    })

    it('does not mark auth_required when upstream returns 500', async () => {
      setupSuccessPath({ upstreamStatus: 500, upstreamBody: '{"error":"server error"}' })

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      await new Promise((r) => setTimeout(r, 10))

      const authRequiredCalls = mockUpdateSet.mock.calls.filter(
        (call) => call[0]?.status === 'auth_required'
      )
      expect(authRequiredCalls).toHaveLength(0)
    })

    it('passes through the 401 response body from upstream', async () => {
      setupSuccessPath({
        upstreamStatus: 401,
        upstreamBody: '{"error":"token_expired","message":"Please re-authenticate"}',
      })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('token_expired')
    })
  })

  // =========================================================================
  // 8. Proxy request forwarding
  // =========================================================================
  describe('proxy request forwarding', () => {
    it('forwards the HTTP method correctly', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/json',
        },
        body: '{"data":"test"}',
      })

      const [, init] = mockFetch.mock.calls[0]
      expect(init.method).toBe('POST')
    })

    it('forwards PUT request with body', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/resource/123', {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/json',
        },
        body: '{"name":"updated"}',
      })

      const [, init] = mockFetch.mock.calls[0]
      expect(init.method).toBe('PUT')
      expect(init.body).toBeDefined()
    })

    it('forwards DELETE request without body', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/resource/123', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [, init] = mockFetch.mock.calls[0]
      expect(init.method).toBe('DELETE')
    })

    it('does not include body for GET requests', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [, init] = mockFetch.mock.calls[0]
      expect(init.method).toBe('GET')
      expect(init.body).toBeUndefined()
    })

    it('passes upstream status code through to the client (e.g. 201)', async () => {
      setupSuccessPath({ upstreamStatus: 201, upstreamBody: '{"id":"new-resource"}' })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/json',
        },
        body: '{"name":"test"}',
      })

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.id).toBe('new-resource')
    })

    it('passes through 404 response from upstream', async () => {
      setupSuccessPath({
        upstreamStatus: 404,
        upstreamBody: '{"error":"not_found"}',
      })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/resource/999', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('not_found')
    })

    it('passes through 500 response from upstream', async () => {
      setupSuccessPath({
        upstreamStatus: 500,
        upstreamBody: '{"error":"internal_error"}',
      })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.status).toBe(500)
    })
  })

  // =========================================================================
  // 9. Upstream fetch failure (502)
  // =========================================================================
  describe('upstream fetch failure', () => {
    it('returns 502 when upstream fetch throws', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp()
      setupDbMocks(mcp)

      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.error).toContain('proxy request failed')
      expect(body.details).toContain('ECONNREFUSED')
    })

    it('returns 502 when upstream fetch times out', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp()
      setupDbMocks(mcp)

      mockFetch.mockRejectedValueOnce(new Error('AbortError: The operation was aborted'))

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.details).toContain('AbortError')
    })

    it('logs audit entry on upstream fetch failure', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp()
      setupDbMocks(mcp)

      mockFetch.mockRejectedValueOnce(new Error('network error'))

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(mockInsertValues).toHaveBeenCalled()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.errorMessage).toContain('Proxy request failed')
      expect(entry.agentSlug).toBe('my-agent')
      expect(entry.remoteMcpId).toBe('mcp-1')
      expect(entry.remoteMcpName).toBe('Test MCP')
      expect(entry.durationMs).toBeDefined()
    })
  })

  // =========================================================================
  // 10. Audit logging
  // =========================================================================
  describe('audit logging', () => {
    it('logs audit entry on successful proxy request', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/some/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      await new Promise((r) => setTimeout(r, 10))

      expect(mockInsertValues).toHaveBeenCalled()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.agentSlug).toBe('my-agent')
      expect(entry.remoteMcpId).toBe('mcp-1')
      expect(entry.remoteMcpName).toBe('Test MCP')
      expect(entry.method).toBe('GET')
      expect(entry.statusCode).toBe(200)
      expect(entry.errorMessage).toBeNull()
      expect(entry.durationMs).toBeGreaterThanOrEqual(0)
      expect(entry.createdAt).toBeInstanceOf(Date)
      expect(entry.id).toBeDefined()
    })

    it('audit log failure does not break the proxy response', async () => {
      setupSuccessPath()
      mockInsertValues.mockRejectedValue(new Error('DB write failed'))

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.status).toBe(200)
    })

    it('logs audit entry with token refresh failure error', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        tokenExpiresAt: new Date(Date.now() - 60_000),
      })
      setupDbMocks(mcp)

      mockFetch.mockResolvedValueOnce(
        new Response('{"error":"invalid"}', { status: 400 })
      )

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      // The audit log from the token refresh failure
      expect(mockInsertValues).toHaveBeenCalled()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.errorMessage).toContain('Token refresh failed')
    })

    it('records durationMs for successful requests', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      await new Promise((r) => setTimeout(r, 10))

      const entry = mockInsertValues.mock.calls[0][0]
      expect(typeof entry.durationMs).toBe('number')
      expect(entry.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('records durationMs for failed requests', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp()
      setupDbMocks(mcp)
      mockFetch.mockRejectedValueOnce(new Error('timeout'))

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const entry = mockInsertValues.mock.calls[0][0]
      expect(typeof entry.durationMs).toBe('number')
      expect(entry.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('logs the HTTP method in audit entry', async () => {
      setupSuccessPath()

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      await new Promise((r) => setTimeout(r, 10))

      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.method).toBe('POST')
    })
  })

  // =========================================================================
  // 11. Edge cases
  // =========================================================================
  describe('edge cases', () => {
    it('handles Bearer token with a very short value', async () => {
      mockValidateProxyToken.mockResolvedValue(null)

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer x' },
      })

      expect(res.status).toBe(401)
      expect(mockValidateProxyToken).toHaveBeenCalledWith('x')
    })

    it('handles MCP URL with port number', async () => {
      setupSuccessPath({ mcpOverrides: { url: 'https://mcp.example.com:8443' } })

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/v1/tools', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://mcp.example.com:8443/v1/tools')
    })

    it('handles MCP URL with path prefix', async () => {
      setupSuccessPath({ mcpOverrides: { url: 'https://mcp.example.com/api/v2' } })

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/tools/list', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://mcp.example.com/api/v2/tools/list')
    })

    it('handles MCP URL with path prefix and trailing slash', async () => {
      setupSuccessPath({ mcpOverrides: { url: 'https://mcp.example.com/api/v2/' } })

      await makeRequest('/api/mcp-proxy/my-agent/mcp-1/tools/list', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://mcp.example.com/api/v2/tools/list')
    })

    it('handles authType bearer (not oauth) with existing accessToken', async () => {
      setupSuccessPath({
        mcpOverrides: {
          authType: 'bearer',
          accessToken: 'static-api-key-123',
          tokenExpiresAt: null,
          refreshToken: null,
        },
      })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.status).toBe(200)
      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Headers
      expect(headers.get('Authorization')).toBe('Bearer static-api-key-123')
    })

    it('returns 401 when authType is bearer but no accessToken is set', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      const mcp = buildMcp({
        authType: 'bearer',
        accessToken: null,
        tokenExpiresAt: null,
        refreshToken: null,
      })
      setupDbMocks(mcp)

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toContain('no access token')
    })

    it('handles concurrent requests to different MCP servers', async () => {
      // This test just verifies that two requests can proceed independently.
      // Both return success.
      const mcp1 = buildMcp({ id: 'mcp-1', name: 'MCP One', url: 'https://one.example.com' })
      const mcp2 = buildMcp({ id: 'mcp-2', name: 'MCP Two', url: 'https://two.example.com' })

      mockValidateProxyToken.mockResolvedValue('my-agent')

      // First request setup
      mockDbFrom.mockReturnValueOnce({ innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ mcp: mcp1 }]) }) }) })
      mockFetch.mockResolvedValueOnce(new Response('{"server":"one"}', { status: 200 }))

      // Second request setup
      mockDbFrom.mockReturnValueOnce({ innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ mcp: mcp2 }]) }) }) })
      mockFetch.mockResolvedValueOnce(new Response('{"server":"two"}', { status: 200 }))

      const [res1, res2] = await Promise.all([
        makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
          headers: { Authorization: 'Bearer synth_valid' },
        }),
        makeRequest('/api/mcp-proxy/my-agent/mcp-2/path', {
          headers: { Authorization: 'Bearer synth_valid' },
        }),
      ])

      expect(res1.status).toBe(200)
      expect(res2.status).toBe(200)
    })

    it('expired token with refreshToken but tokenExpiresAt is null does not trigger refresh', async () => {
      // tokenExpiresAt is null => the condition `mcp.tokenExpiresAt && ...` is false
      // so no refresh is attempted, and existing accessToken is used
      setupSuccessPath({
        mcpOverrides: {
          tokenExpiresAt: null,
          refreshToken: 'some-refresh',
          accessToken: 'still-valid-tok',
        },
      })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.status).toBe(200)
      // Only one fetch (the proxy call), no refresh attempt
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Headers
      expect(headers.get('Authorization')).toBe('Bearer still-valid-tok')
    })

    it('expired token without refreshToken skips refresh and uses existing (possibly stale) token', async () => {
      // tokenExpiresAt < now BUT refreshToken is null =>
      // the condition `mcp.tokenExpiresAt && mcp.tokenExpiresAt.getTime() < Date.now() && mcp.refreshToken` is false
      // so we go on with the existing accessToken
      setupSuccessPath({
        mcpOverrides: {
          tokenExpiresAt: new Date(Date.now() - 60_000),
          refreshToken: null,
          accessToken: 'stale-but-exists',
        },
      })

      const res = await makeRequest('/api/mcp-proxy/my-agent/mcp-1/path', {
        headers: { Authorization: 'Bearer synth_valid' },
      })

      expect(res.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Headers
      expect(headers.get('Authorization')).toBe('Bearer stale-but-exists')
    })
  })
})

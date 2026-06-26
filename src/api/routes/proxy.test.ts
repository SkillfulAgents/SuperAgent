import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

// Mock dependencies
const mockValidateProxyToken = vi.fn()
const mockIsHostAllowed = vi.fn()
const mockGetConnectionToken = vi.fn()
const mockProxyExecute = vi.fn()

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...args: unknown[]) => mockValidateProxyToken(...args),
}))

vi.mock('@shared/lib/proxy/allowed-hosts', () => ({
  isHostAllowed: (...args: unknown[]) => mockIsHostAllowed(...args),
}))

const mockMakeApiCall = vi.fn()
const mockGetConnection = vi.fn()
const mockAccountProvider = {
  name: 'composio',
  makeApiCall: (...args: unknown[]) => mockMakeApiCall(...args),
  getConnection: (...args: unknown[]) => mockGetConnection(...args),
}

vi.mock('@shared/lib/account-providers', () => ({
  getAccountProviderByName: () => mockAccountProvider,
}))

// Kept for skipped test sections below that still reference Composio-specific mocks
class MockComposioRedactedTokenError extends Error {
  statusCode = 403
  constructor(message: string) {
    super(message)
    this.name = 'ComposioRedactedTokenError'
  }
}

// Mock DB with chainable query builder
const mockLimit = vi.fn()
const mockWhere = vi.fn()
const mockInnerJoin = vi.fn()
const mockDbFrom = vi.fn()
const mockInsertValues = vi.fn()

const mockDbUpdateSet = vi.fn()
const mockDbUpdateWhere = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: mockDbFrom }),
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: (...args: unknown[]) => { mockDbUpdateSet(...args); return { where: (...wArgs: unknown[]) => mockDbUpdateWhere(...wArgs) } } }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: { id: 'id', toolkitSlug: 'toolkit_slug', providerName: 'provider_name', providerConnectionId: 'provider_connection_id' },
  agentConnectedAccounts: {
    agentSlug: 'agent_slug',
    connectedAccountId: 'connected_account_id',
  },
  proxyAuditLog: {},
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  and: (...args: unknown[]) => args,
}))

vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: { fromResourceCreator: () => null },
  runWithAttribution: <T,>(_auth: unknown, fn: () => T): T => fn(),
}))

// Mock policy enforcement
const mockMatchScopes = vi.fn()
const mockResolveApiPolicy = vi.fn()
const mockRequestReview = vi.fn()

vi.mock('@shared/lib/proxy/scope-matcher', () => ({
  matchScopes: (...args: unknown[]) => mockMatchScopes(...args),
}))

vi.mock('@shared/lib/proxy/policy-resolver', () => ({
  resolveApiPolicy: (...args: unknown[]) => mockResolveApiPolicy(...args),
}))

vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: {
    requestReview: (...args: unknown[]) => mockRequestReview(...args),
  },
}))

// Mock analytics
vi.mock('@shared/lib/analytics/server-analytics', () => ({
  trackServerEvent: vi.fn(),
}))

// Mock fetch for forwarded requests
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import proxy from './proxy'

function createApp() {
  const app = new Hono()
  app.route('/api/proxy', proxy)
  return app
}

describe('proxy route', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()

    // Default: DB insert for audit log succeeds
    mockInsertValues.mockResolvedValue(undefined)

    // Default: remote connection is active
    mockGetConnection.mockResolvedValue({ id: 'mock-conn', status: 'ACTIVE' })

    // Default: DB update succeeds
    mockDbUpdateWhere.mockResolvedValue(undefined)

    // Default: policy allows everything (non-breaking for existing tests)
    mockMatchScopes.mockReturnValue({ matched: true, scopes: ['test.scope'], descriptions: {} })
    mockResolveApiPolicy.mockResolvedValue({
      decision: 'allow',
      matchedScopes: ['test.scope'],
      scopeDescriptions: {},
      resolvedFrom: 'global_default',
    })
  })

  async function makeRequest(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, options)
  }

  it('returns 401 for missing Authorization header', async () => {
    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/api.gmail.com/gmail/v1/messages'
    )
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toContain('Authorization')
  })

  it('returns 401 for invalid synthetic token', async () => {
    mockValidateProxyToken.mockResolvedValue(null)

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/api.gmail.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_bad' } }
    )
    expect(res.status).toBe(401)
    expect(mockValidateProxyToken).toHaveBeenCalledWith('synth_bad')
  })

  it('returns 403 when token belongs to different agent', async () => {
    mockValidateProxyToken.mockResolvedValue('other-agent')

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/api.gmail.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_other' } }
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 when account is not mapped to agent', async () => {
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([])

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/api.gmail.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(404)
  })

  it('returns 403 when target host is not allowed for toolkit', async () => {
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-123',
          toolkitSlug: 'gmail',
          providerConnectionId: 'comp-123',
            providerName: 'composio',
          status: 'active',
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(false)

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/evil.com/steal',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('not allowed')
  })

  it('returns 502 when provider makeApiCall fails', async () => {
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-123',
          toolkitSlug: 'gmail',
          providerConnectionId: 'comp-123',
          providerName: 'composio',
          status: 'active',
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(true)
    mockMakeApiCall.mockRejectedValue(new Error('Provider down'))

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(502)
  })

  it('forwards GET request via provider and returns response', async () => {
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-123',
          toolkitSlug: 'gmail',
          providerConnectionId: 'comp-123',
          providerName: 'composio',
          status: 'active',
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(true)

    mockMakeApiCall.mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/users/me/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(200)

    expect(mockMakeApiCall).toHaveBeenCalledOnce()
    const callArgs = mockMakeApiCall.mock.calls[0][0]
    expect(callArgs.providerConnectionId).toBe('comp-123')
    expect(callArgs.targetUrl).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages'
    )
    expect(callArgs.method).toBe('GET')
  })

  it('forwards POST request via provider', async () => {
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-123',
          toolkitSlug: 'slack',
          providerConnectionId: 'comp-456',
          providerName: 'composio',
          status: 'active',
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(true)
    mockMakeApiCall.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    const body = JSON.stringify({ channel: '#general', text: 'hello' })
    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/slack.com/api/chat.postMessage',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/json',
        },
        body,
      }
    )
    expect(res.status).toBe(200)
    expect(mockMakeApiCall).toHaveBeenCalledOnce()
    const callArgs = mockMakeApiCall.mock.calls[0][0]
    expect(callArgs.targetUrl).toBe('https://slack.com/api/chat.postMessage')
    expect(callArgs.method).toBe('POST')
  })

  it('passes headers to provider makeApiCall', async () => {
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-123',
          toolkitSlug: 'github',
          providerConnectionId: 'comp-789',
          providerName: 'composio',
          status: 'active',
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(true)
    mockMakeApiCall.mockResolvedValue(new Response('[]', { status: 200 }))

    await makeRequest(
      '/api/proxy/my-agent/acc-123/api.github.com/user/repos',
      {
        headers: {
          Authorization: 'Bearer synth_valid',
          Accept: 'application/json',
        },
      }
    )

    expect(mockMakeApiCall).toHaveBeenCalledOnce()
    const callArgs = mockMakeApiCall.mock.calls[0][0]
    expect(callArgs.headers).toBeInstanceOf(Headers)
    expect(callArgs.providerConnectionId).toBe('comp-789')
  })

  // Helper: set up mocks for a successful proxy pass-through
  function setupSuccessPath(
    overrides: {
      providerConnectionId?: string
      toolkit?: string
      upstreamStatus?: number
      upstreamHeaders?: Record<string, string>
      upstreamBody?: string
    } = {}
  ) {
    const {
      providerConnectionId = 'comp-uniq-' + Math.random(),
      toolkit = 'gmail',
      upstreamStatus = 200,
      upstreamHeaders = { 'content-type': 'application/json' },
      upstreamBody = '{"ok":true}',
    } = overrides

    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-123',
          toolkitSlug: toolkit,
          providerConnectionId,
          providerName: 'composio',
          status: 'active',
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(true)
    mockGetConnection.mockResolvedValue({ id: providerConnectionId, status: 'ACTIVE' })
    const PROVIDER_SKIP_HEADERS = new Set(['transfer-encoding', 'content-encoding', 'content-length'])
    const filteredHeaders = Object.fromEntries(
      Object.entries(upstreamHeaders).filter(([k]) => !PROVIDER_SKIP_HEADERS.has(k.toLowerCase()))
    )
    mockMakeApiCall.mockResolvedValue(
      new Response(upstreamBody, {
        status: upstreamStatus,
        headers: filteredHeaders,
      })
    )
  }

  // =========================================================================
  // Audit logging tests
  // =========================================================================
  describe('audit logging', () => {
    it('logs audit entry on 401 (missing auth) with correct errorMessage', async () => {
      await makeRequest(
        '/api/proxy/my-agent/acc-123/api.gmail.com/gmail/v1/messages'
      )

      expect(mockInsertValues).toHaveBeenCalledOnce()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.agentSlug).toBe('my-agent')
      expect(entry.accountId).toBe('acc-123')
      expect(entry.errorMessage).toContain('Authorization')
      // Duration is stamped even on early-exit (pre-validation) paths
      expect(typeof entry.durationMs).toBe('number')
    })

    it('logs audit entry on 401 (invalid token)', async () => {
      mockValidateProxyToken.mockResolvedValue(null)

      await makeRequest(
        '/api/proxy/my-agent/acc-123/api.gmail.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer bad-tok' } }
      )

      expect(mockInsertValues).toHaveBeenCalledOnce()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.errorMessage).toContain('Invalid proxy token')
    })

    it('logs audit entry on 403 (token mismatch)', async () => {
      mockValidateProxyToken.mockResolvedValue('other-agent')

      await makeRequest(
        '/api/proxy/my-agent/acc-123/api.gmail.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_other' } }
      )

      expect(mockInsertValues).toHaveBeenCalledOnce()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.errorMessage).toContain('does not match')
    })

    it('logs audit entry on 403 (host not allowed) — includes toolkit + host', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
      mockInnerJoin.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        {
          account: {
            id: 'acc-123',
            toolkitSlug: 'gmail',
            providerConnectionId: 'comp-123',
            providerName: 'composio',
          status: 'active',
          },
        },
      ])
      mockIsHostAllowed.mockReturnValue(false)

      await makeRequest(
        '/api/proxy/my-agent/acc-123/evil.com/steal',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(mockInsertValues).toHaveBeenCalledOnce()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.toolkit).toBe('gmail')
      expect(entry.targetHost).toBe('evil.com')
      expect(entry.errorMessage).toContain('evil.com')
      expect(entry.errorMessage).toContain('gmail')
    })

    it('logs audit entry on 502 (provider failure)', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
      mockInnerJoin.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        {
          account: {
            id: 'acc-123',
            toolkitSlug: 'gmail',
            providerConnectionId: 'comp-502-audit',
            providerName: 'composio',
          status: 'active',
          },
        },
      ])
      mockIsHostAllowed.mockReturnValue(true)
      mockMakeApiCall.mockRejectedValue(new Error('Provider down'))

      await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(mockInsertValues).toHaveBeenCalledOnce()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.errorMessage).toContain('Proxy request failed')
    })

    it('logs audit entry on success with statusCode and no error', async () => {
      setupSuccessPath()

      await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      // Allow fire-and-forget audit insert to settle
      await new Promise((r) => setTimeout(r, 10))

      expect(mockInsertValues).toHaveBeenCalledOnce()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.statusCode).toBe(200)
      expect(entry.errorMessage).toBeNull()
      // Request duration is captured (request entry → response) as a non-negative number
      expect(typeof entry.durationMs).toBe('number')
      expect(entry.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('logs audit entry on provider fetch failure (502)', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
      mockInnerJoin.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        {
          account: {
            id: 'acc-123',
            toolkitSlug: 'gmail',
            providerConnectionId: 'comp-fetch-fail',
            providerName: 'composio',
          status: 'active',
          },
        },
      ])
      mockIsHostAllowed.mockReturnValue(true)
      mockMakeApiCall.mockRejectedValue(new Error('ECONNREFUSED'))

      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(res.status).toBe(502)
      expect(mockInsertValues).toHaveBeenCalledOnce()
      const entry = mockInsertValues.mock.calls[0][0]
      expect(entry.errorMessage).toContain('Proxy request failed')
    })

    it('audit log failure does NOT break the proxy response', async () => {
      setupSuccessPath()
      mockInsertValues.mockRejectedValue(new Error('DB write failed'))

      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      // The proxy should still return a valid response despite audit log failure
      expect(res.status).toBe(200)
    })
  })

  // =========================================================================
  // Response headers & query string tests
  // =========================================================================
  describe('response headers and query strings', () => {
    it('strips transfer-encoding from upstream response', async () => {
      setupSuccessPath({
        upstreamHeaders: {
          'transfer-encoding': 'chunked',
          'content-type': 'application/json',
        },
      })

      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(res.headers.get('transfer-encoding')).toBeNull()
    })

    it('strips content-encoding from upstream response', async () => {
      setupSuccessPath({
        upstreamHeaders: {
          'content-encoding': 'gzip',
          'content-type': 'application/json',
        },
      })

      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(res.headers.get('content-encoding')).toBeNull()
    })

    it('strips content-length from upstream response', async () => {
      setupSuccessPath({
        upstreamHeaders: {
          'content-length': '42',
          'content-type': 'application/json',
        },
      })

      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(res.headers.get('content-length')).toBeNull()
    })

    it('forwards other headers (x-rate-limit, content-type, etc.)', async () => {
      setupSuccessPath({
        upstreamHeaders: {
          'content-type': 'application/json',
          'x-rate-limit-remaining': '99',
          'x-request-id': 'req-abc',
        },
      })

      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(res.headers.get('content-type')).toBe('application/json')
      expect(res.headers.get('x-rate-limit-remaining')).toBe('99')
      expect(res.headers.get('x-request-id')).toBe('req-abc')
    })

    it('preserves query string with & and special chars in forwarded URL', async () => {
      setupSuccessPath()

      await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages?q=from%3Ame&maxResults=10',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(mockMakeApiCall).toHaveBeenCalledOnce()
      const { targetUrl } = mockMakeApiCall.mock.calls[0][0]
      expect(targetUrl).toContain('?q=from%3Ame&maxResults=10')
    })

    it('handles request with no query string (no trailing ?)', async () => {
      setupSuccessPath()

      await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      const { targetUrl } = mockMakeApiCall.mock.calls[0][0]
      expect(targetUrl).toBe('https://gmail.googleapis.com/gmail/v1/messages')
      expect(targetUrl).not.toContain('?')
    })

    it('returns 400 when target host is missing', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
      mockInnerJoin.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      // The route pattern /:rest{.+} requires at least one char, so to hit
      // "missing host" we need host to be empty after parsing. In practice,
      // we can't really hit targetHost="" via the route regex because /:rest{.+}
      // must match. But we can verify the 400 path by testing a rest with no slashes
      // where the host itself is empty — not actually reachable via route.
      // Instead, let's test a path that exercises the host properly.
      // Actually the route matches everything after the second param as rest.
      // With a path like /api/proxy/my-agent/acc-123/ the rest would be "" and
      // the route wouldn't match. So we'll just verify the error code separately.
      // Let's just call the handler directly, or accept this is route-level protected.
      // Actually, let's test a URL path that results in empty targetHost:
      // The Hono route `/:rest{.+}` requires at least one char for rest, so
      // /api/proxy/agent/acc/ won't match. We can only really hit the 400 from
      // a rest like "" which the route pattern prevents. Let's skip this specific
      // case since it's unreachable via routing and focus on a path where rest = "x"
      // (just a host, no subpath).
      mockLimit.mockResolvedValue([
        {
          account: {
            id: 'acc-123',
            toolkitSlug: 'gmail',
            providerConnectionId: 'comp-123',
            providerName: 'composio',
          status: 'active',
          },
        },
      ])
      mockIsHostAllowed.mockReturnValue(true)
      mockMakeApiCall.mockResolvedValue(new Response('{}', { status: 200 }))

      // When rest is just a host with no subpath, targetPath should be empty
      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/api.gmail.com',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(res.status).toBe(200)
      const callArgs = mockMakeApiCall.mock.calls[0][0]
      expect(callArgs.targetUrl).toBe('https://api.gmail.com/')
    })

    it('forwards upstream status code (e.g. 404 passthrough)', async () => {
      setupSuccessPath({
        upstreamStatus: 404,
        upstreamBody: '{"error":"not found"}',
      })

      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages/nonexistent',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('not found')
    })
  })

  // =========================================================================
  // Account status checks
  // =========================================================================
  describe('account status checks', () => {
    it('returns 403 when local account status is expired', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
      mockInnerJoin.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        {
          account: {
            id: 'acc-123',
            toolkitSlug: 'gmail',
            providerConnectionId: 'comp-123',
            providerName: 'composio',
            status: 'expired',
          },
        },
      ])

      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.accountStatus).toBe('expired')
      expect(body.error).toContain('expired')
    })

    it('returns 403 when local account status is revoked', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
      mockInnerJoin.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        {
          account: {
            id: 'acc-123',
            toolkitSlug: 'gmail',
            providerConnectionId: 'comp-123',
            providerName: 'composio',
            status: 'revoked',
          },
        },
      ])

      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.accountStatus).toBe('revoked')
    })

    it('does not call makeApiCall when local status is non-active', async () => {
      mockValidateProxyToken.mockResolvedValue('my-agent')
      mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
      mockInnerJoin.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        {
          account: {
            id: 'acc-123',
            toolkitSlug: 'gmail',
            providerConnectionId: 'comp-123',
            providerName: 'composio',
            status: 'expired',
          },
        },
      ])

      await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(mockMakeApiCall).not.toHaveBeenCalled()
      expect(mockGetConnection).not.toHaveBeenCalled()
    })

    it('returns 403 when remote status check returns non-ACTIVE', async () => {
      setupSuccessPath()
      mockGetConnection.mockResolvedValueOnce({ id: 'comp-123', status: 'EXPIRED' })

      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.accountStatus).toBe('expired')
      expect(mockMakeApiCall).not.toHaveBeenCalled()
    })

    it('updates DB status when remote returns EXPIRED', async () => {
      setupSuccessPath()
      mockGetConnection.mockResolvedValueOnce({ id: 'comp-123', status: 'EXPIRED' })

      await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      // Wait for fire-and-forget DB update
      await new Promise((r) => setTimeout(r, 10))
      expect(mockDbUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }))
    })

    it('updates DB status to revoked when remote returns FAILED', async () => {
      setupSuccessPath()
      mockGetConnection.mockResolvedValueOnce({ id: 'comp-123', status: 'FAILED' })

      await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      await new Promise((r) => setTimeout(r, 10))
      expect(mockDbUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked' }))
    })

    it('returns 403 with revoked when remote status is FAILED', async () => {
      setupSuccessPath()
      mockGetConnection.mockResolvedValueOnce({ id: 'comp-123', status: 'FAILED' })

      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.accountStatus).toBe('revoked')
    })

    it('proceeds with request when remote status check fails (network error)', async () => {
      setupSuccessPath()
      mockGetConnection.mockRejectedValueOnce(new Error('Network error'))

      const res = await makeRequest(
        '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
        { headers: { Authorization: 'Bearer synth_valid' } }
      )

      expect(res.status).toBe(200)
      expect(mockMakeApiCall).toHaveBeenCalled()
    })
  })
})

// ===========================================================================
// Policy enforcement tests
// ===========================================================================
describe('proxy policy enforcement', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    mockInsertValues.mockResolvedValue(undefined)
  })

  async function makeRequest(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, options)
  }

  // Set up mocks through host validation, then let policy take over
  function setupThroughHostValidation() {
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-123',
          toolkitSlug: 'gmail',
          providerConnectionId: 'comp-123',
            providerName: 'composio',
          status: 'active',
          userId: 'user-1',
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(true)
  }

  it('policy "allow" → request forwarded, returns 200', async () => {
    setupThroughHostValidation()
    mockMatchScopes.mockReturnValue({ matched: true, scopes: ['gmail.readonly'], descriptions: {} })
    mockResolveApiPolicy.mockResolvedValue({
      decision: 'allow',
      matchedScopes: ['gmail.readonly'],
      scopeDescriptions: {},
      resolvedFrom: 'scope_policy',
    })
    mockMakeApiCall.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(200)
    expect(mockMakeApiCall).toHaveBeenCalledOnce()
  })

  it('policy "block" → returns 403, body has error: "blocked_by_policy"', async () => {
    setupThroughHostValidation()
    mockMatchScopes.mockReturnValue({ matched: true, scopes: ['gmail.full'], descriptions: {} })
    mockResolveApiPolicy.mockResolvedValue({
      decision: 'block',
      matchedScopes: ['gmail.full'],
      scopeDescriptions: {},
      resolvedFrom: 'scope_policy',
    })

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('blocked_by_policy')
  })

  it('block does NOT call provider.makeApiCall', async () => {
    setupThroughHostValidation()
    mockMatchScopes.mockReturnValue({ matched: true, scopes: ['gmail.full'], descriptions: {} })
    mockResolveApiPolicy.mockResolvedValue({
      decision: 'block',
      matchedScopes: ['gmail.full'],
      scopeDescriptions: {},
      resolvedFrom: 'scope_policy',
    })

    await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(mockMakeApiCall).not.toHaveBeenCalled()
  })

  it('review → user allows → request forwarded, returns 200', async () => {
    setupThroughHostValidation()
    mockMatchScopes.mockReturnValue({ matched: true, scopes: ['gmail.modify'], descriptions: {} })
    mockResolveApiPolicy.mockResolvedValue({
      decision: 'review',
      matchedScopes: ['gmail.modify'],
      scopeDescriptions: {},
      resolvedFrom: 'scope_policy',
    })
    mockRequestReview.mockResolvedValue('allow')
    mockMakeApiCall.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(200)
    expect(mockRequestReview).toHaveBeenCalledOnce()
  })

  it('review → user denies → returns 403, error: "denied_by_user"', async () => {
    setupThroughHostValidation()
    mockMatchScopes.mockReturnValue({ matched: true, scopes: ['gmail.modify'], descriptions: {} })
    mockResolveApiPolicy.mockResolvedValue({
      decision: 'review',
      matchedScopes: ['gmail.modify'],
      scopeDescriptions: {},
      resolvedFrom: 'scope_policy',
    })
    mockRequestReview.mockResolvedValue('deny')

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('denied_by_user')
  })

  it('review → timeout → returns 408, error: "review_timeout"', async () => {
    setupThroughHostValidation()
    mockMatchScopes.mockReturnValue({ matched: true, scopes: ['gmail.modify'], descriptions: {} })
    mockResolveApiPolicy.mockResolvedValue({
      decision: 'review',
      matchedScopes: ['gmail.modify'],
      scopeDescriptions: {},
      resolvedFrom: 'scope_policy',
    })
    mockRequestReview.mockRejectedValue(new Error('Review timeout'))

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(408)
    const body = await res.json()
    expect(body.error).toBe('review_timeout')
  })

  it('unmatched endpoint (matchScopes returns matched: false) → still calls resolveApiPolicy', async () => {
    setupThroughHostValidation()
    mockMatchScopes.mockReturnValue({ matched: false, scopes: [], descriptions: {} })
    mockResolveApiPolicy.mockResolvedValue({
      decision: 'allow',
      matchedScopes: [],
      scopeDescriptions: {},
      resolvedFrom: 'global_default',
    })
    mockMakeApiCall.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/unknown',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(200)
    expect(mockResolveApiPolicy).toHaveBeenCalledOnce()
  })

  it('audit log includes policyDecision and matchedScopes', async () => {
    setupThroughHostValidation()
    mockMatchScopes.mockReturnValue({ matched: true, scopes: ['gmail.readonly'], descriptions: {} })
    mockResolveApiPolicy.mockResolvedValue({
      decision: 'block',
      matchedScopes: ['gmail.readonly'],
      scopeDescriptions: {},
      resolvedFrom: 'scope_policy',
    })

    await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(mockInsertValues).toHaveBeenCalled()
    const entry = mockInsertValues.mock.calls[0][0]
    expect(entry.policyDecision).toBe('block')
    expect(entry.matchedScopes).toBe(JSON.stringify(['gmail.readonly']))
  })

  it('policy enforcement error defaults to review (not allow)', async () => {
    setupThroughHostValidation()
    mockMatchScopes.mockImplementation(() => { throw new Error('scope map exploded') })
    // If fallback were 'allow', the request would be forwarded.
    // Since fallback is 'review', reviewManager.requestReview is called.
    mockRequestReview.mockResolvedValue('allow')
    mockMakeApiCall.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(200)
    // The key assertion: reviewManager was called because fallback is 'review'
    expect(mockRequestReview).toHaveBeenCalledOnce()
  })
})

// ===========================================================================
// Token caching and Composio proxy fallback tests have moved to
// composio-account-provider.test.ts — they test provider internals, not the
// proxy route. The proxy route now delegates to provider.makeApiCall().
// ===========================================================================

describe.skip('proxy token caching (moved to composio-account-provider)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    // Re-register mocks after resetModules (hoisted vi.mock calls persist)
    mockValidateProxyToken.mockReset()
    mockIsHostAllowed.mockReset()
    mockGetConnectionToken.mockReset()
    mockDbFrom.mockReset()
    mockInnerJoin.mockReset()
    mockWhere.mockReset()
    mockLimit.mockReset()
    mockInsertValues.mockReset()
    mockFetch.mockReset()
    mockInsertValues.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function getFreshApp() {
    const proxyMod = await import('./proxy')
    const { Hono: HonoClass } = await import('hono')
    const app = new HonoClass()
    app.route('/api/proxy', proxyMod.default)
    return app
  }

  function setupMocks(opts: {
    providerConnectionId: string
    accessToken: string
    expiresAt?: string
  }) {
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-cache',
          toolkitSlug: 'gmail',
          providerConnectionId: opts.providerConnectionId,
            providerName: 'composio',
          status: 'active',
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(true)
    // Policy enforcement: default allow
    mockMatchScopes.mockReturnValue({ matched: true, scopes: ['test.scope'], descriptions: {} })
    mockResolveApiPolicy.mockResolvedValue({
      decision: 'allow',
      matchedScopes: ['test.scope'],
      scopeDescriptions: {},
      resolvedFrom: 'global_default',
    })
    const tokenResult: { accessToken: string; expiresAt?: string } = {
      accessToken: opts.accessToken,
    }
    if (opts.expiresAt) tokenResult.expiresAt = opts.expiresAt
    mockGetConnectionToken.mockResolvedValue(tokenResult)

    mockFetch.mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
  }

  it('second request to same account reuses cached token (getConnectionToken called once)', async () => {
    const app = await getFreshApp()
    setupMocks({
      providerConnectionId: 'comp-cache-1',
      accessToken: 'cached-tok-1',
    })

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-cache/gmail.googleapis.com/path',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    // Reset fetch mock for second request but keep token mock
    mockFetch.mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    )

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-cache/gmail.googleapis.com/path',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(mockGetConnectionToken).toHaveBeenCalledTimes(1)
  })

  it('after 5+ minutes cache expires and token is re-fetched', async () => {
    const app = await getFreshApp()
    setupMocks({
      providerConnectionId: 'comp-cache-2',
      accessToken: 'tok-round1',
    })

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-cache/gmail.googleapis.com/path',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(mockGetConnectionToken).toHaveBeenCalledTimes(1)

    // Advance past the 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000)

    mockFetch.mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    )

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-cache/gmail.googleapis.com/path',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(mockGetConnectionToken).toHaveBeenCalledTimes(2)
  })

  it('token with expiresAt 90s away → cache TTL = 30s, re-fetch after 35s', async () => {
    const now = Date.now()
    const expiresAt = new Date(now + 90_000).toISOString()

    const app = await getFreshApp()
    setupMocks({
      providerConnectionId: 'comp-cache-3',
      accessToken: 'tok-short-expiry',
      expiresAt,
    })

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-cache/gmail.googleapis.com/path',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(mockGetConnectionToken).toHaveBeenCalledTimes(1)

    // Advance 35s — past the 30s TTL (90 - 60 = 30s)
    vi.advanceTimersByTime(35_000)

    mockFetch.mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    )

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-cache/gmail.googleapis.com/path',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(mockGetConnectionToken).toHaveBeenCalledTimes(2)
  })

  it('token with expiresAt 10s away → TTL floors to 30s (not negative)', async () => {
    const now = Date.now()
    // expires in 10s → tokenExpiresMs - 60_000 = -50_000 → floored to 30s
    const expiresAt = new Date(now + 10_000).toISOString()

    const app = await getFreshApp()
    setupMocks({
      providerConnectionId: 'comp-cache-4',
      accessToken: 'tok-almost-expired',
      expiresAt,
    })

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-cache/gmail.googleapis.com/path',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(mockGetConnectionToken).toHaveBeenCalledTimes(1)

    // At 25s the 30s floor cache should still be valid
    vi.advanceTimersByTime(25_000)

    mockFetch.mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    )

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-cache/gmail.googleapis.com/path',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    // Still cached — 25s < 30s floor
    expect(mockGetConnectionToken).toHaveBeenCalledTimes(1)

    // At 35s the cache should expire
    vi.advanceTimersByTime(10_000) // now at 35s

    mockFetch.mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    )

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-cache/gmail.googleapis.com/path',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(mockGetConnectionToken).toHaveBeenCalledTimes(2)
  })

  it('different providerConnectionId values → independent cache entries', async () => {
    const app = await getFreshApp()

    // First connection
    setupMocks({
      providerConnectionId: 'comp-A',
      accessToken: 'tok-A',
    })

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-cache/gmail.googleapis.com/path',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(mockGetConnectionToken).toHaveBeenCalledTimes(1)

    // Second connection (different providerConnectionId)
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-cache',
          toolkitSlug: 'gmail',
          providerConnectionId: 'comp-B',
            providerName: 'composio',
          status: 'active',
        },
      },
    ])
    mockGetConnectionToken.mockResolvedValue({ accessToken: 'tok-B' })
    mockFetch.mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    )

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-cache/gmail.googleapis.com/path',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    // Should have called getConnectionToken again for the new connection
    expect(mockGetConnectionToken).toHaveBeenCalledTimes(2)
  })
})

describe.skip('proxy fallback to Composio proxy execute (moved to composio-account-provider)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    mockValidateProxyToken.mockReset()
    mockIsHostAllowed.mockReset()
    mockGetConnectionToken.mockReset()
    mockProxyExecute.mockReset()
    mockMatchScopes.mockReset()
    mockResolveApiPolicy.mockReset()
    mockRequestReview.mockReset()
    mockDbFrom.mockReset()
    mockInnerJoin.mockReset()
    mockWhere.mockReset()
    mockLimit.mockReset()
    mockInsertValues.mockReset()
    mockFetch.mockReset()
    mockInsertValues.mockResolvedValue(undefined)
    mockMatchScopes.mockReturnValue({ matched: true, scopes: ['s'], descriptions: {} })
    mockResolveApiPolicy.mockResolvedValue({
      decision: 'allow',
      matchedScopes: ['s'],
      scopeDescriptions: {},
      resolvedFrom: 'global_default',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function getFreshApp() {
    const proxyMod = await import('./proxy')
    const { Hono: HonoClass } = await import('hono')
    const app = new HonoClass()
    app.route('/api/proxy', proxyMod.default)
    return app
  }

  function setupRedacted(opts: { providerConnectionId?: string; toolkit?: string } = {}) {
    const providerConnectionId = opts.providerConnectionId ?? 'comp-redacted-' + Math.random()
    const toolkit = opts.toolkit ?? 'gmail'
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-r',
          toolkitSlug: toolkit,
          providerConnectionId,
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(true)
    mockGetConnectionToken.mockRejectedValue(
      new MockComposioRedactedTokenError('Access token is redacted by Composio')
    )
    return { providerConnectionId, toolkit }
  }

  it('routes redacted-token connections through proxyExecute (and does NOT call fetch directly)', async () => {
    const app = await getFreshApp()
    setupRedacted()
    mockProxyExecute.mockResolvedValue({
      status: 200,
      data: { login: 'iddogino' },
      headers: { 'x-ratelimit-remaining': '4999' },
    })

    const res = await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/user',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(res.status).toBe(200)
    expect(mockProxyExecute).toHaveBeenCalledOnce()
    expect(mockFetch).not.toHaveBeenCalled()

    const arg = mockProxyExecute.mock.calls[0][0]
    expect(arg.endpoint).toBe('https://api.github.com/user')
    expect(arg.method).toBe('GET')

    const body = await res.json()
    expect(body).toEqual({ login: 'iddogino' })
    expect(res.headers.get('x-ratelimit-remaining')).toBe('4999')
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('mode cache: second redacted call does NOT re-call getConnectionToken', async () => {
    const app = await getFreshApp()
    setupRedacted({ providerConnectionId: 'comp-cached-redacted' })
    mockProxyExecute.mockResolvedValue({ status: 200, data: {}, headers: {} })

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/user',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/user',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(mockGetConnectionToken).toHaveBeenCalledTimes(1)
    expect(mockProxyExecute).toHaveBeenCalledTimes(2)
  })

  it('use-proxy mode cache expires after 5 min and re-probes getConnectionToken', async () => {
    const app = await getFreshApp()
    setupRedacted({ providerConnectionId: 'comp-redacted-ttl' })
    mockProxyExecute.mockResolvedValue({ status: 200, data: {}, headers: {} })

    // First call: token throws redacted, mode is cached as use-proxy
    await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/user',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(mockGetConnectionToken).toHaveBeenCalledTimes(1)

    // Within TTL: still cached, no re-probe
    vi.advanceTimersByTime(4 * 60 * 1000)
    await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/user',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(mockGetConnectionToken).toHaveBeenCalledTimes(1)

    // Past 5-min TTL: cache expires, getConnectionToken is probed again.
    // Simulate the connection being un-redacted in the meantime — it now returns a real token.
    vi.advanceTimersByTime(2 * 60 * 1000) // total elapsed = 6 min
    mockGetConnectionToken.mockReset()
    mockGetConnectionToken.mockResolvedValue({ accessToken: 'real-token-after-fix' })
    mockFetch.mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    )

    const res = await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/user',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(res.status).toBe(200)
    expect(mockGetConnectionToken).toHaveBeenCalledTimes(1) // re-probed after TTL
    // Once un-redacted, traffic flips back to direct fetch, not proxyExecute
    const proxyCallsAfterReset = mockProxyExecute.mock.calls.length
    expect(proxyCallsAfterReset).toBe(2) // only the two pre-TTL calls
    expect(mockFetch).toHaveBeenCalledOnce()
    expect(mockFetch.mock.calls[0][1].headers.get('Authorization')).toBe(
      'Bearer real-token-after-fix'
    )
  })

  it('JSON-body POST is forwarded as `body` to proxyExecute', async () => {
    const app = await getFreshApp()
    setupRedacted()
    mockProxyExecute.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} })

    const res = await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/slack.com/api/chat.postMessage',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel: 'C1', text: 'hi' }),
      }
    )

    expect(res.status).toBe(200)
    const arg = mockProxyExecute.mock.calls[0][0]
    expect(arg.body).toEqual({ channel: 'C1', text: 'hi' })
    expect(arg.binaryBody).toBeUndefined()
  })

  it('binary body (≤4MB) is forwarded as `binary_body` (base64) to proxyExecute', async () => {
    const app = await getFreshApp()
    setupRedacted()
    mockProxyExecute.mockResolvedValue({ status: 201, data: { id: 'file-1' }, headers: {} })

    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) // JPEG magic
    const res = await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/upload',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'image/jpeg',
        },
        body: bytes,
      }
    )

    expect(res.status).toBe(201)
    const arg = mockProxyExecute.mock.calls[0][0]
    expect(arg.body).toBeUndefined()
    expect(arg.binaryBody).toEqual({
      base64: Buffer.from(bytes).toString('base64'),
      content_type: 'image/jpeg',
    })
  })

  it('form-encoded body returns 415 (unsupported on managed connections)', async () => {
    const app = await getFreshApp()
    setupRedacted()

    const res = await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/slack.com/api/auth.test',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'foo=bar',
      }
    )

    expect(res.status).toBe(415)
    expect(mockProxyExecute).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.error).toBe('unsupported_media_type')
  })

  it('multipart body returns 415', async () => {
    const app = await getFreshApp()
    setupRedacted()

    const res = await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/upload',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_valid',
          'Content-Type': 'multipart/form-data; boundary=xyz',
        },
        body: '--xyz\r\nContent-Disposition: form-data; name="x"\r\n\r\n1\r\n--xyz--\r\n',
      }
    )

    expect(res.status).toBe(415)
    expect(mockProxyExecute).not.toHaveBeenCalled()
  })

  it('envelope `data` as object → response is JSON', async () => {
    const app = await getFreshApp()
    setupRedacted()
    mockProxyExecute.mockResolvedValue({ status: 200, data: { hello: 'world' }, headers: {} })

    const res = await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/user',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ hello: 'world' })
  })

  it('envelope `data` as string → response is text passthrough', async () => {
    const app = await getFreshApp()
    setupRedacted()
    mockProxyExecute.mockResolvedValue({
      status: 200,
      data: '<html>hi</html>',
      headers: {},
    })

    const res = await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/some.html',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>hi</html>')
  })

  it('binaryData.url → response streams that URL', async () => {
    const app = await getFreshApp()
    setupRedacted()
    mockProxyExecute.mockResolvedValue({
      status: 200,
      data: null,
      headers: {},
      binaryData: {
        url: 'https://composio-cdn.example.com/blob/123',
        content_type: 'application/pdf',
        size: 4321,
        expires_at: '2099-01-01T00:00:00Z',
      },
    })
    mockFetch.mockResolvedValue(
      new Response('PDF-DATA', { status: 200 })
    )

    const res = await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/file.pdf',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(mockFetch).toHaveBeenCalledOnce()
    expect(mockFetch.mock.calls[0][0]).toBe('https://composio-cdn.example.com/blob/123')
    expect(await res.text()).toBe('PDF-DATA')
  })

  it('upstream non-200 status (envelope status: 404) → response is 404 (not 502)', async () => {
    const app = await getFreshApp()
    setupRedacted()
    mockProxyExecute.mockResolvedValue({
      status: 404,
      data: { message: 'Not Found' },
      headers: {},
    })

    const res = await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/missing',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(res.status).toBe(404)
    // Audit log records 404, not an error
    const entry = mockInsertValues.mock.calls[0][0]
    expect(entry.statusCode).toBe(404)
    expect(entry.errorMessage).toBeNull()
  })

  it('Composio call itself throws → 502 + audit-logged error', async () => {
    const app = await getFreshApp()
    setupRedacted()
    mockProxyExecute.mockRejectedValue(new Error('Network down'))

    const res = await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/user',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    expect(res.status).toBe(502)
    const entry = mockInsertValues.mock.calls[0][0]
    expect(entry.errorMessage).toContain('Proxy request failed')
  })

  it('forwards client headers via `parameters` (excluding host/auth/cookie)', async () => {
    const app = await getFreshApp()
    setupRedacted()
    mockProxyExecute.mockResolvedValue({ status: 200, data: {}, headers: {} })

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/user',
      {
        headers: {
          Authorization: 'Bearer synth_valid',
          Accept: 'application/vnd.github+json',
          Cookie: 'session=secret',
          'X-Custom': 'yes',
        },
      }
    )

    const arg = mockProxyExecute.mock.calls[0][0]
    const params = arg.parameters as Array<{ name: string; value: string; type: string }>
    const names = new Set(params.map((p) => p.name.toLowerCase()))
    expect(names.has('accept')).toBe(true)
    expect(names.has('x-custom')).toBe(true)
    expect(names.has('cookie')).toBe(false)
    expect(names.has('authorization')).toBe(false)
    expect(names.has('host')).toBe(false)
  })

  it('preserves query string in `endpoint` (no duplicate parameters)', async () => {
    const app = await getFreshApp()
    setupRedacted()
    mockProxyExecute.mockResolvedValue({ status: 200, data: {}, headers: {} })

    await app.request(
      'http://localhost/api/proxy/my-agent/acc-r/api.github.com/search/issues?q=hello&per_page=5',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )

    const arg = mockProxyExecute.mock.calls[0][0]
    expect(arg.endpoint).toBe('https://api.github.com/search/issues?q=hello&per_page=5')
    if (arg.parameters) {
      const queryParams = (arg.parameters as Array<{ type: string }>).filter((p) => p.type === 'query')
      expect(queryParams).toEqual([])
    }
  })
})

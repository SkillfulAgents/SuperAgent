import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

// Mock auth middleware — always pass through
vi.mock('../middleware/auth', () => {
  const passthrough: MiddlewareHandler = async (_c, next) => next()
  return {
    Authenticated: () => passthrough,
    UsersMcpServer: () => passthrough,
    IsAdmin: () => passthrough,
    Or: () => passthrough,
  }
})

const mockGetCurrentUserId = vi.fn().mockReturnValue('user-1')
const mockGetAppBaseUrlFromRequest = vi.fn().mockReturnValue('http://localhost:3000')

vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: (...args: unknown[]) => mockGetCurrentUserId(...args),
  getAppBaseUrlFromRequest: (...args: unknown[]) => mockGetAppBaseUrlFromRequest(...args),
}))

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => false,
}))

// Mock OAuth functions
const mockInitiateOAuthFlow = vi.fn()
const mockInitiateNewServerOAuth = vi.fn()
const mockCompleteOAuthFlow = vi.fn()
const mockDiscoverOAuthMetadata = vi.fn()
const mockValidateAndConsumeOAuthErrorResponse = vi.fn()

vi.mock('@shared/lib/mcp/oauth', () => ({
  initiateOAuthFlow: (...args: unknown[]) => mockInitiateOAuthFlow(...args),
  initiateNewServerOAuth: (...args: unknown[]) => mockInitiateNewServerOAuth(...args),
  completeOAuthFlow: (...args: unknown[]) => mockCompleteOAuthFlow(...args),
  validateAndConsumeOAuthErrorResponse: (...args: unknown[]) =>
    mockValidateAndConsumeOAuthErrorResponse(...args),
  discoverOAuthMetadata: (...args: unknown[]) => mockDiscoverOAuthMetadata(...args),
}))

// Mock DB with chainable query builder
const mockLimit = vi.fn()
const mockWhere = vi.fn()
const mockDbFrom = vi.fn()
const mockInsertValues = vi.fn()
const mockSet = vi.fn()
const mockDeleteWhere = vi.fn()
const mockOrderBy = vi.fn()
const mockDynamic = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: mockDbFrom }),
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: mockSet }),
    delete: () => ({ where: mockDeleteWhere }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  remoteMcpServers: {
    id: 'id',
    userId: 'user_id',
    createdAt: 'created_at',
  },
  agentRemoteMcps: {
    id: 'id',
    agentSlug: 'agent_slug',
    remoteMcpId: 'remote_mcp_id',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  and: (...args: unknown[]) => args,
}))

// Mock global fetch for discoverTools internal calls
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Import after mocks
import remoteMcps from './remote-mcps'

function createApp() {
  const app = new Hono()
  app.route('/api/remote-mcps', remoteMcps)
  return app
}

// ---------------------------------------------------------------------------
// parseMcpResponse tests — exercised through POST / which uses discoverTools,
// which calls parseMcpResponse internally.
//
// Since parseMcpResponse is a private function, we test it through the route
// that triggers it. The POST / route calls discoverTools, which calls
// parseMcpResponse on the initialize and tools/list responses.
// ---------------------------------------------------------------------------
describe('parseMcpResponse (via discoverTools through POST /)', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  it('parses JSON response from MCP server', async () => {
    // discoverTools makes 3 fetches: initialize, notifications/initialized, tools/list
    // Initialize response — plain JSON
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: '2025-03-26' }, id: 1 }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': 'session-123',
          },
        }
      )
    )
    // Notification response — no body needed
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    // Tools list response — plain JSON
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: {
            tools: [
              { name: 'search', description: 'Search the web' },
              { name: 'calculate', description: 'Do math', inputSchema: { type: 'object' } },
            ],
          },
          id: 2,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    // After discoverTools succeeds, POST / does a DB insert and select
    mockInsertValues.mockResolvedValue(undefined)
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        id: 'mcp-new',
        name: 'Test MCP',
        url: 'https://mcp.example.com',
        toolsJson: JSON.stringify([
          { name: 'search', description: 'Search the web' },
          { name: 'calculate', description: 'Do math', inputSchema: { type: 'object' } },
        ]),
        accessToken: 'secret-tok',
        refreshToken: 'secret-refresh',
        oauthClientSecret: 'secret-cs',
      },
    ])

    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test MCP', url: 'https://mcp.example.com' }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.server.tools).toHaveLength(2)
    expect(body.server.tools[0].name).toBe('search')
    expect(body.server.tools[1].name).toBe('calculate')
  })

  it('parses SSE (text/event-stream) response — extracts last valid JSON-RPC message', async () => {
    const sseBody = [
      'event: message',
      'data: {"jsonrpc":"2.0","method":"progress","params":{"progress":50}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","result":{"protocolVersion":"2025-03-26"},"id":1}',
      '',
    ].join('\n')

    // Initialize response — SSE format
    mockFetch.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )
    // Notification
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    // Tools list — also SSE format
    const toolsSse = [
      'event: message',
      'data: {"jsonrpc":"2.0","result":{"tools":[{"name":"sse_tool","description":"Found via SSE"}]},"id":2}',
      '',
    ].join('\n')
    mockFetch.mockResolvedValueOnce(
      new Response(toolsSse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )

    mockInsertValues.mockResolvedValue(undefined)
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        id: 'mcp-sse',
        name: 'SSE MCP',
        url: 'https://mcp.example.com',
        toolsJson: JSON.stringify([{ name: 'sse_tool', description: 'Found via SSE' }]),
        accessToken: null,
        refreshToken: null,
        oauthClientSecret: null,
      },
    ])

    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'SSE MCP', url: 'https://mcp.example.com' }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.server.tools).toHaveLength(1)
    expect(body.server.tools[0].name).toBe('sse_tool')
  })

  it('extracts last valid JSON-RPC message from SSE with multiple data lines', async () => {
    // SSE with multiple data lines — should use the last one with result/id
    const sseBody = [
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notification","params":{}}',
      '',
      'event: message',
      'data: not valid json here',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","result":{"protocolVersion":"2025-03-26"},"id":1}',
      '',
    ].join('\n')

    mockFetch.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: { tools: [{ name: 'tool1' }] },
          id: 2,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    mockInsertValues.mockResolvedValue(undefined)
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        id: 'mcp-multi',
        name: 'Multi SSE',
        url: 'https://mcp.example.com',
        toolsJson: JSON.stringify([{ name: 'tool1' }]),
        accessToken: null,
        refreshToken: null,
        oauthClientSecret: null,
      },
    ])

    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Multi SSE', url: 'https://mcp.example.com' }),
    })

    expect(res.status).toBe(201)
  })

  it('returns 502 when SSE contains no valid JSON-RPC messages (malformed)', async () => {
    // SSE with only malformed data lines
    const sseBody = [
      'event: message',
      'data: not json at all',
      '',
      'event: message',
      'data: {"no_result":"and_no_id"}',
      '',
    ].join('\n')

    mockFetch.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )

    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad MCP', url: 'https://mcp.example.com' }),
    })

    // discoverTools throws → route returns 502
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toContain('No valid JSON-RPC response')
  })

  it('returns 502 when SSE response is empty', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )

    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Empty MCP', url: 'https://mcp.example.com' }),
    })

    expect(res.status).toBe(502)
  })
})

// ---------------------------------------------------------------------------
// discoverTools — MCP handshake protocol
// ---------------------------------------------------------------------------
describe('discoverTools (via POST /)', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  it('performs full MCP handshake: initialize → notification → tools/list', async () => {
    // Initialize
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: '2025-03-26' }, id: 1 }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': 'sess-abc',
          },
        }
      )
    )
    // Notification
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    // Tools list
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: {
            tools: [{ name: 'my_tool', description: 'A tool' }],
          },
          id: 2,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    mockInsertValues.mockResolvedValue(undefined)
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        id: 'mcp-xyz',
        name: 'Test',
        url: 'https://mcp.example.com',
        toolsJson: JSON.stringify([{ name: 'my_tool', description: 'A tool' }]),
        accessToken: null,
        refreshToken: null,
        oauthClientSecret: null,
      },
    ])

    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', url: 'https://mcp.example.com' }),
    })

    expect(res.status).toBe(201)

    // Verify the 3 fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(3)

    // Call 1: initialize
    const initCall = mockFetch.mock.calls[0]
    expect(initCall[0]).toBe('https://mcp.example.com')
    const initBody = JSON.parse(initCall[1].body)
    expect(initBody.method).toBe('initialize')
    expect(initBody.params.clientInfo.name).toBe('Superagent')

    // Call 2: notifications/initialized — includes session ID
    const notifCall = mockFetch.mock.calls[1]
    const notifBody = JSON.parse(notifCall[1].body)
    expect(notifBody.method).toBe('notifications/initialized')
    expect(notifCall[1].headers['Mcp-Session-Id']).toBe('sess-abc')

    // Call 3: tools/list
    const toolsCall = mockFetch.mock.calls[2]
    const toolsBody = JSON.parse(toolsCall[1].body)
    expect(toolsBody.method).toBe('tools/list')
    expect(toolsCall[1].headers['Mcp-Session-Id']).toBe('sess-abc')
  })

  it('sends bearer token in Authorization header when provided', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: { tools: [] }, id: 2 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    mockInsertValues.mockResolvedValue(undefined)
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        id: 'mcp-bearer',
        name: 'Bearer Test',
        url: 'https://mcp.example.com',
        toolsJson: '[]',
        accessToken: null,
        refreshToken: null,
        oauthClientSecret: null,
      },
    ])

    await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bearer Test',
        url: 'https://mcp.example.com',
        authType: 'bearer',
        accessToken: 'my-secret-bearer-token',
      }),
    })

    // Verify bearer token was sent
    const initHeaders = mockFetch.mock.calls[0][1].headers
    expect(initHeaders['Authorization']).toBe('Bearer my-secret-bearer-token')
  })

  it('returns 502 when initialize call fails', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 })
    )

    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Failing MCP', url: 'https://mcp.example.com' }),
    })

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toContain('500')
  })

  it('returns 502 when tools/list call fails', async () => {
    // Initialize succeeds
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    // Notification succeeds
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    // Tools list fails
    mockFetch.mockResolvedValueOnce(
      new Response('Service Unavailable', { status: 503 })
    )

    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Broken MCP', url: 'https://mcp.example.com' }),
    })

    expect(res.status).toBe(502)
  })

  it('detects 401 and checks for OAuth requirements', async () => {
    // Initialize returns 401
    mockFetch.mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    )
    // discoverOAuthMetadata returns valid metadata → needsOAuth
    mockDiscoverOAuthMetadata.mockResolvedValueOnce({
      metadata: {
        authorization_endpoint: 'https://auth.example.com/auth',
        token_endpoint: 'https://auth.example.com/token',
      },
      resource: 'https://mcp.example.com',
    })

    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'OAuth MCP', url: 'https://mcp.example.com' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.needsOAuth).toBe(true)
    expect(body.error).toContain('OAuth')
  })

  it('returns empty tools array when server returns no tools', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: {}, id: 2 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    mockInsertValues.mockResolvedValue(undefined)
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        id: 'mcp-empty',
        name: 'Empty Tools',
        url: 'https://mcp.example.com',
        toolsJson: '[]',
        accessToken: null,
        refreshToken: null,
        oauthClientSecret: null,
      },
    ])

    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Empty Tools', url: 'https://mcp.example.com' }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.server.tools).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Token stripping from GET responses
// ---------------------------------------------------------------------------
describe('GET / — token stripping', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  it('strips accessToken, refreshToken, and oauthClientSecret from response', async () => {
    mockDbFrom.mockReturnValue({ orderBy: mockOrderBy })
    mockOrderBy.mockReturnValue({ $dynamic: mockDynamic })
    mockDynamic.mockResolvedValue([
      {
        id: 'mcp-1',
        name: 'My Server',
        url: 'https://mcp.example.com',
        accessToken: 'super-secret-access-token',
        refreshToken: 'super-secret-refresh-token',
        oauthClientSecret: 'super-secret-client-secret',
        toolsJson: JSON.stringify([{ name: 'tool1' }]),
        status: 'active',
      },
    ])

    const res = await app.request('http://localhost/api/remote-mcps')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.servers).toHaveLength(1)

    const server = body.servers[0]
    expect(server.accessToken).toBeUndefined()
    expect(server.refreshToken).toBeUndefined()
    expect(server.oauthClientSecret).toBeUndefined()

    // But other fields are present
    expect(server.id).toBe('mcp-1')
    expect(server.name).toBe('My Server')
    expect(server.tools).toEqual([{ name: 'tool1' }])
  })

  it('returns empty tools array when toolsJson is null', async () => {
    mockDbFrom.mockReturnValue({ orderBy: mockOrderBy })
    mockOrderBy.mockReturnValue({ $dynamic: mockDynamic })
    mockDynamic.mockResolvedValue([
      {
        id: 'mcp-2',
        name: 'No Tools',
        url: 'https://mcp.example.com',
        accessToken: null,
        refreshToken: null,
        oauthClientSecret: null,
        toolsJson: null,
        status: 'active',
      },
    ])

    const res = await app.request('http://localhost/api/remote-mcps')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.servers[0].tools).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// GET /:id — single server, also strips tokens
// ---------------------------------------------------------------------------
describe('GET /:id — token stripping', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  it('strips tokens from single server response', async () => {
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        id: 'mcp-single',
        name: 'Single Server',
        url: 'https://mcp.example.com',
        accessToken: 'secret-access',
        refreshToken: 'secret-refresh',
        oauthClientSecret: 'secret-client',
        toolsJson: JSON.stringify([{ name: 'tool1' }]),
      },
    ])

    const res = await app.request('http://localhost/api/remote-mcps/mcp-single')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.server.accessToken).toBeUndefined()
    expect(body.server.refreshToken).toBeUndefined()
    expect(body.server.oauthClientSecret).toBeUndefined()
    expect(body.server.tools).toEqual([{ name: 'tool1' }])
  })

  it('returns 404 when server not found', async () => {
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([])

    const res = await app.request('http://localhost/api/remote-mcps/nonexistent')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST / — validation
// ---------------------------------------------------------------------------
describe('POST / — validation', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  it('returns 400 when name is missing', async () => {
    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://mcp.example.com' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('required')
  })

  it('returns 400 when url is missing', async () => {
    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when authType is oauth (must use /initiate-oauth)', async () => {
    const res = await app.request('http://localhost/api/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'OAuth Server',
        url: 'https://mcp.example.com',
        authType: 'oauth',
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('initiate-oauth')
  })
})

// ---------------------------------------------------------------------------
// SSRF protection — reject private/loopback/non-HTTP URLs
// ---------------------------------------------------------------------------
describe('SSRF protection', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  describe('POST / — rejects unsafe URLs before any fetch', () => {
    it.each([
      ['http://192.168.1.1/mcp', 'private 192.168.x.x'],
      ['http://10.0.0.1/mcp', 'private 10.x.x.x'],
      ['http://172.16.0.1/mcp', 'private 172.16.x.x'],
      ['http://169.254.169.254/latest/meta-data', 'cloud metadata endpoint'],
      ['http://box.local/mcp', '.local domain'],
    ])('rejects %s (%s)', async (url) => {
      const res = await app.request('http://localhost/api/remote-mcps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Evil MCP', url }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/private|loopback/)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it.each([
      ['http://127.0.0.1/mcp', 'loopback IPv4'],
      ['http://localhost/mcp', 'localhost'],
      ['http://[::1]/mcp', 'loopback IPv6'],
      ['http://foo.localhost/mcp', 'subdomain of localhost'],
    ])('rejects localhost URL %s (%s) in non-Electron mode', async (url) => {
      const res = await app.request('http://localhost/api/remote-mcps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Local MCP', url }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/private|loopback/)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it.each([
      ['ftp://evil.com/mcp', 'FTP'],
      ['file:///etc/passwd', 'file://'],
      ['javascript:alert(1)', 'javascript:'],
    ])('rejects non-HTTP URL: %s (%s)', async (url) => {
      const res = await app.request('http://localhost/api/remote-mcps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Evil MCP', url }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/Unsafe URL protocol|Invalid URL/)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('allows public HTTPS URLs', async () => {
      // Initialize
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jsonrpc: '2.0', result: { tools: [] }, id: 2 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      mockInsertValues.mockResolvedValue(undefined)
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        {
          id: 'mcp-ok',
          name: 'Public MCP',
          url: 'https://mcp.example.com',
          toolsJson: '[]',
          accessToken: null,
          refreshToken: null,
          oauthClientSecret: null,
        },
      ])

      const res = await app.request('http://localhost/api/remote-mcps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Public MCP', url: 'https://mcp.example.com' }),
      })

      expect(res.status).toBe(201)
      expect(mockFetch).toHaveBeenCalled()
    })
  })

  describe('POST / — allows localhost in Electron mode', () => {
    const originalProcessType = process.type

    beforeEach(() => {
      Object.defineProperty(process, 'type', { value: 'browser', configurable: true })
    })

    afterEach(() => {
      Object.defineProperty(process, 'type', { value: originalProcessType, configurable: true })
    })

    function mockSuccessfulDiscoverTools() {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jsonrpc: '2.0', result: { tools: [] }, id: 2 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      mockInsertValues.mockResolvedValue(undefined)
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
    }

    it.each([
      ['http://127.0.0.1:8080/mcp', 'loopback IPv4'],
      ['http://localhost:3000/mcp', 'localhost'],
      ['http://[::1]:9090/mcp', 'loopback IPv6'],
      ['http://foo.localhost:4000/mcp', 'subdomain of localhost'],
    ])('allows %s (%s) in Electron mode', async (url) => {
      mockSuccessfulDiscoverTools()
      mockLimit.mockResolvedValue([
        {
          id: 'mcp-local',
          name: 'Local MCP',
          url,
          toolsJson: '[]',
          accessToken: null,
          refreshToken: null,
          oauthClientSecret: null,
        },
      ])

      const res = await app.request('http://localhost/api/remote-mcps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Local MCP', url }),
      })

      expect(res.status).toBe(201)
      expect(mockFetch).toHaveBeenCalled()
    })

    it.each([
      ['http://192.168.1.1/mcp', 'private LAN'],
      ['http://10.0.0.1/mcp', 'private 10.x'],
      ['http://169.254.169.254/latest/meta-data', 'cloud metadata'],
    ])('still rejects non-localhost private URL %s (%s) even in Electron mode', async (url) => {
      const res = await app.request('http://localhost/api/remote-mcps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Evil MCP', url }),
      })

      expect(res.status).toBe(400)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('POST /initiate-oauth — rejects unsafe URLs for new servers', () => {
    it('rejects private host URLs', async () => {
      const res = await app.request('http://localhost/api/remote-mcps/initiate-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Evil OAuth', url: 'http://192.168.1.1/mcp' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/private|loopback/)
      expect(mockInitiateNewServerOAuth).not.toHaveBeenCalled()
    })

    it('does not validate URL for existing server re-auth (mcpId path)', async () => {
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        { id: 'mcp-existing', url: 'https://mcp.example.com' },
      ])
      mockInitiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com/auth',
        state: 'state-123',
      })

      const res = await app.request('http://localhost/api/remote-mcps/initiate-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpId: 'mcp-existing' }),
      })

      expect(res.status).toBe(200)
    })
  })

  describe('POST /initiate-oauth — redirect candidates', () => {
    it('offers the custom app scheme then an http loopback for Electron (so strict AS like cal.com can fall back)', async () => {
      mockInitiateNewServerOAuth.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com/auth',
        state: 'state-xyz',
      })

      const res = await app.request('http://localhost/api/remote-mcps/initiate-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Cal.com', url: 'https://mcp.cal.com/mcp', electron: true }),
      })

      expect(res.status).toBe(200)
      const [url, name, candidates, electron] = mockInitiateNewServerOAuth.mock.calls[0]
      expect(url).toBe('https://mcp.cal.com/mcp')
      expect(name).toBe('Cal.com')
      expect(electron).toBe(true)
      // Custom scheme is preferred; the loopback comes from the request origin.
      expect(candidates).toEqual([
        'superagent://mcp-oauth-callback',
        'http://localhost/api/remote-mcps/oauth-callback',
      ])
    })

    it('offers only the http redirect for the web app', async () => {
      mockInitiateNewServerOAuth.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com/auth',
        state: 'state-xyz',
      })

      await app.request('http://localhost/api/remote-mcps/initiate-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Cal.com', url: 'https://mcp.cal.com/mcp' }),
      })

      const [, , candidates, electron] = mockInitiateNewServerOAuth.mock.calls[0]
      expect(electron).toBe(false)
      expect(candidates).toEqual(['http://localhost:3000/api/remote-mcps/oauth-callback'])
    })
  })

  describe('PATCH /:id — rejects unsafe URL updates', () => {
    it('rejects private host URL in update', async () => {
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      mockLimit.mockResolvedValue([
        { id: 'mcp-1', name: 'Old', url: 'https://mcp.example.com' },
      ])

      const res = await app.request('http://localhost/api/remote-mcps/mcp-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1:8080/evil' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/private|loopback/)
    })

    it('allows updating to a public URL', async () => {
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ limit: mockLimit })
      // First call: existing server lookup
      mockLimit.mockResolvedValueOnce([
        { id: 'mcp-1', name: 'Old', url: 'https://old.example.com' },
      ])
      mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })
      // Second call: updated server fetch
      mockLimit.mockResolvedValueOnce([
        {
          id: 'mcp-1',
          name: 'Old',
          url: 'https://new.example.com',
          toolsJson: '[]',
          accessToken: null,
          refreshToken: null,
          oauthClientSecret: null,
        },
      ])

      const res = await app.request('http://localhost/api/remote-mcps/mcp-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://new.example.com' }),
      })

      expect(res.status).toBe(200)
    })
  })
})

// ---------------------------------------------------------------------------
// GET /:id/agents — list agent slugs that have this MCP server mapped
// ---------------------------------------------------------------------------
describe('GET /:id/agents', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  it('returns an empty list when the MCP has no agent mappings', async () => {
    // GET /:id/agents calls .select(...).from(table).where(eq(...)) and awaits.
    mockDbFrom.mockReturnValue({ where: vi.fn().mockResolvedValue([]) })

    const res = await app.request('http://localhost/api/remote-mcps/m-1/agents')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ agentSlugs: [] })
  })

  it('returns the slugs of every agent that has the MCP mapped', async () => {
    mockDbFrom.mockReturnValue({
      where: vi.fn().mockResolvedValue([
        { agentSlug: 'alpha' },
        { agentSlug: 'beta' },
        { agentSlug: 'gamma' },
      ]),
    })

    const res = await app.request('http://localhost/api/remote-mcps/m-2/agents')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ agentSlugs: ['alpha', 'beta', 'gamma'] })
  })

  it('returns 500 when the DB query throws', async () => {
    mockDbFrom.mockReturnValue({
      where: vi.fn().mockRejectedValue(new Error('boom')),
    })

    const res = await app.request('http://localhost/api/remote-mcps/m-3/agents')
    expect(res.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — postMessage uses window.location.origin, not '*'
// ---------------------------------------------------------------------------
describe('OAuth callback — postMessage origin', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  it('uses window.location.origin (not wildcard) on error', async () => {
    mockValidateAndConsumeOAuthErrorResponse.mockReturnValueOnce({ valid: true })

    const res = await app.request(
      'http://localhost/api/remote-mcps/oauth-callback?error=access_denied&state=xyz'
    )

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('window.location.origin')
    expect(html).not.toContain("'*'")
  })

  it('escapes authorization-server error text once on the callback page', async () => {
    mockValidateAndConsumeOAuthErrorResponse.mockReturnValueOnce({ valid: true })

    const res = await app.request(
      'http://localhost/api/remote-mcps/oauth-callback?error=%3Cbad%3E&state=xyz'
    )

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('OAuth error: &lt;bad&gt;. You can close this window.')
    expect(html).not.toContain('&amp;lt;bad&amp;gt;')
    expect(html).toContain('"error":"\\u003cbad\\u003e"')
  })

  it('does not display authorization-server error fields when issuer validation fails', async () => {
    mockValidateAndConsumeOAuthErrorResponse.mockReturnValueOnce({
      valid: false,
      error: 'OAuth issuer validation failed',
    })

    const res = await app.request(
      'http://localhost/api/remote-mcps/oauth-callback?error=access_denied&error_description=Do+not+show+me&error_uri=https%3A%2F%2Fevil.example.com%2Fdocs&state=xyz&iss=https%3A%2F%2Fevil.example.com'
    )

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('OAuth callback validation failed')
    expect(html).not.toContain('access_denied')
    expect(html).not.toContain('Do not show me')
    expect(html).not.toContain('evil.example.com')
    expect(mockValidateAndConsumeOAuthErrorResponse).toHaveBeenCalledWith(
      'xyz',
      'https://evil.example.com'
    )
    expect(mockCompleteOAuthFlow).not.toHaveBeenCalled()
  })

  it('uses window.location.origin (not wildcard) on token exchange failure', async () => {
    mockCompleteOAuthFlow.mockResolvedValue({ success: false })

    const res = await app.request(
      'http://localhost/api/remote-mcps/oauth-callback?code=abc&state=xyz'
    )

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('window.location.origin')
    expect(html).not.toContain("'*'")
  })

  it('passes iss through for successful authorization responses', async () => {
    mockCompleteOAuthFlow.mockResolvedValue({ success: false })

    await app.request(
      'http://localhost/api/remote-mcps/oauth-callback?code=abc&state=xyz&iss=https%3A%2F%2Fauth.example.com'
    )

    expect(mockCompleteOAuthFlow).toHaveBeenCalledWith(
      'xyz',
      'abc',
      'https://auth.example.com'
    )
  })

  it('uses window.location.origin (not wildcard) on success', async () => {
    mockCompleteOAuthFlow.mockResolvedValue({ success: true, mcpId: 'mcp-new' })
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      { id: 'mcp-new', url: 'https://mcp.example.com', accessToken: 'tok' },
    ])

    // discoverTools fetches
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: { tools: [] }, id: 2 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })

    const res = await app.request(
      'http://localhost/api/remote-mcps/oauth-callback?code=abc&state=xyz'
    )

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('window.location.origin')
    expect(html).not.toContain("'*'")
  })

  it('emits callback fallbacks for web popups whose opener was severed', async () => {
    mockCompleteOAuthFlow.mockResolvedValue({ success: true, mcpId: 'mcp-new' })
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      { id: 'mcp-new', url: 'https://mcp.example.com', accessToken: 'tok' },
    ])
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: { tools: [] }, id: 2 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })

    const res = await app.request(
      'http://localhost/api/remote-mcps/oauth-callback?code=abc&state=xyz'
    )

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("new BroadcastChannel('mcp-oauth-callback')")
    expect(html).toContain("localStorage.setItem('superagent.mcp-oauth-callback'")
    expect(html).toContain('window.opener?.postMessage')
    expect(html).toContain('setTimeout(() => window.close(), 0)')
    expect(html).toContain('"success":true')
    expect(html).toContain('"mcpId":"mcp-new"')
  })

  it('hands the result back to the app via the custom scheme for the Electron http-loopback flow', async () => {
    // Electron flow whose redirect was the http loopback (redirectWasScheme:false):
    // this callback loads in the external browser, so it must bounce into the app.
    mockCompleteOAuthFlow.mockResolvedValue({
      success: true,
      mcpId: 'mcp-new',
      electron: true,
      redirectWasScheme: false,
    })
    mockDbFrom.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      { id: 'mcp-new', url: 'https://mcp.example.com', accessToken: 'tok' },
    ])
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: { tools: [] }, id: 2 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })

    const res = await app.request(
      'http://localhost/api/remote-mcps/oauth-callback?code=abc&state=xyz'
    )

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('window.location.replace')
    expect(html).toContain('superagent://mcp-oauth-callback?success=true')
    expect(html).toContain('mcpId=mcp-new')
    // NOT the web postMessage/BroadcastChannel bridge.
    expect(html).not.toContain("new BroadcastChannel('mcp-oauth-callback')")
  })
})

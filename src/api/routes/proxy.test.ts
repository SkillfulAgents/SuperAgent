import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// Mock dependencies
const mockValidateProxyToken = vi.fn()
const mockIsHostAllowed = vi.fn()
const mockGetConnectionToken = vi.fn()
const mockDbSelect = vi.fn()
const mockDbInsert = vi.fn()

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...args: unknown[]) => mockValidateProxyToken(...args),
}))

vi.mock('@shared/lib/proxy/allowed-hosts', () => ({
  isHostAllowed: (...args: unknown[]) => mockIsHostAllowed(...args),
}))

vi.mock('@shared/lib/composio/client', () => ({
  getConnectionToken: (...args: unknown[]) => mockGetConnectionToken(...args),
}))

// Mock DB with chainable query builder
const mockLimit = vi.fn()
const mockWhere = vi.fn()
const mockInnerJoin = vi.fn()
const mockDbFrom = vi.fn()
const mockInsertValues = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: mockDbFrom }),
    insert: () => ({ values: mockInsertValues }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: { id: 'id', toolkitSlug: 'toolkit_slug' },
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
          composioConnectionId: 'comp-123',
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

  it('returns 502 when Composio token fetch fails', async () => {
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-123',
          toolkitSlug: 'gmail',
          composioConnectionId: 'comp-123',
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(true)
    mockGetConnectionToken.mockRejectedValue(new Error('Composio down'))

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(502)
  })

  it('forwards GET request with real token and returns response', async () => {
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-123',
          toolkitSlug: 'gmail',
          composioConnectionId: 'comp-123',
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(true)
    mockGetConnectionToken.mockResolvedValue({
      accessToken: 'ya29.real_token',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    })

    const mockResponse = new Response(JSON.stringify({ messages: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    mockFetch.mockResolvedValue(mockResponse)

    const res = await makeRequest(
      '/api/proxy/my-agent/acc-123/gmail.googleapis.com/gmail/v1/users/me/messages',
      { headers: { Authorization: 'Bearer synth_valid' } }
    )
    expect(res.status).toBe(200)

    // Verify the forwarded request used the real token
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages'
    )
    expect(init.headers.get('Authorization')).toBe('Bearer ya29.real_token')
  })

  it('forwards POST request with body', async () => {
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-123',
          toolkitSlug: 'slack',
          composioConnectionId: 'comp-456',
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(true)
    mockGetConnectionToken.mockResolvedValue({
      accessToken: 'xoxb-real-token',
    })

    const mockResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
    })
    mockFetch.mockResolvedValue(mockResponse)

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
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect(init.method).toBe('POST')
  })

  it('does not forward Host or Authorization headers from original request', async () => {
    mockValidateProxyToken.mockResolvedValue('my-agent')
    mockDbFrom.mockReturnValue({ innerJoin: mockInnerJoin })
    mockInnerJoin.mockReturnValue({ where: mockWhere })
    mockWhere.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue([
      {
        account: {
          id: 'acc-123',
          toolkitSlug: 'github',
          composioConnectionId: 'comp-789',
        },
      },
    ])
    mockIsHostAllowed.mockReturnValue(true)
    mockGetConnectionToken.mockResolvedValue({
      accessToken: 'ghp_real',
    })

    const mockResponse = new Response('[]', { status: 200 })
    mockFetch.mockResolvedValue(mockResponse)

    await makeRequest(
      '/api/proxy/my-agent/acc-123/api.github.com/user/repos',
      {
        headers: {
          Authorization: 'Bearer synth_valid',
          Accept: 'application/json',
        },
      }
    )

    const [, init] = mockFetch.mock.calls[0]
    const headers = init.headers as Headers
    // Should have the real token, not the synthetic one
    expect(headers.get('Authorization')).toBe('Bearer ghp_real')
    // Accept should be forwarded
    expect(headers.get('Accept')).toBe('application/json')
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

const mockValidateProxyToken = vi.fn()
const mockGetPlatformAccessToken = vi.fn()
const mockGetPlatformProxyBaseUrl = vi.fn()
const mockDbAll = vi.fn()

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...a: unknown[]) => mockValidateProxyToken(...a),
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => true }))
vi.mock('@shared/lib/auth/index', () => ({ getAuth: () => ({ api: {} }) }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
  getStoredPlatformMemberId: () => null,
}))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => mockGetPlatformProxyBaseUrl(),
}))
vi.mock('@shared/lib/db', () => {
  const chainable = {
    select: () => chainable,
    from: () => chainable,
    where: () => chainable,
    orderBy: () => chainable,
    limit: () => chainable,
    all: () => mockDbAll(),
  }
  return { db: chainable }
})
vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: {
    userId: 'acl.user_id',
    agentSlug: 'acl.agent_slug',
    role: 'acl.role',
    createdAt: 'acl.created_at',
  },
  connectedAccounts: {},
  remoteMcpServers: {},
  notifications: {},
  authAccount: {
    userId: 'account.user_id',
    providerId: 'account.provider_id',
    accountId: 'account.account_id',
    updatedAt: 'account.updated_at',
  },
}))
vi.mock('drizzle-orm', () => ({
  eq: (a: string, b: string) => `${a}=${b}`,
  and: (...args: string[]) => args.join(' AND '),
  asc: (col: string) => `asc(${col})`,
  desc: (col: string) => `DESC(${col})`,
}))

import services from './services'

function orgJwt(orgId: string): string {
  const header = Buffer.from('{"alg":"none"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ orgId })).toString('base64url')
  return `${header}.${payload}.sig`
}

function buildApp() {
  const app = new Hono()
  app.route('/api/services', services)
  return app
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateProxyToken.mockResolvedValue('my-agent')
  mockGetPlatformProxyBaseUrl.mockReturnValue('https://proxy.test')
  mockGetPlatformAccessToken.mockReturnValue('plat_sa_opaque')
  mockDbAll.mockReturnValue([])
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('services route', () => {
  it('returns 404 for an unknown service', async () => {
    const res = await buildApp().request('/api/services/exa/search', {
      headers: { Authorization: 'Bearer proxy-token' },
    })
    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 401 for a missing or invalid proxy token', async () => {
    mockValidateProxyToken.mockResolvedValue(null)
    const res = await buildApp().request('/api/services/replicate/predictions/1', {
      headers: { Authorization: 'Bearer bad-token' },
    })
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 503 when the platform token is missing', async () => {
    mockGetPlatformAccessToken.mockReturnValue(null)
    const res = await buildApp().request('/api/services/replicate/predictions/1', {
      headers: { Authorization: 'Bearer proxy-token' },
    })
    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 503 when the platform proxy URL is empty', async () => {
    mockGetPlatformProxyBaseUrl.mockReturnValue('')
    const res = await buildApp().request('/api/services/replicate/predictions/1', {
      headers: { Authorization: 'Bearer proxy-token' },
    })
    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fail-closes with 503 for an org JWT without an acting member', async () => {
    mockGetPlatformAccessToken.mockReturnValue(orgJwt('org_1'))
    // No ACL owner / authAccount member rows.
    mockDbAll.mockReturnValue([])

    const res = await buildApp().request('/api/services/replicate/predictions/1', {
      headers: { Authorization: 'Bearer proxy-token' },
    })
    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards with an opaque access key when attribution is null', async () => {
    mockGetPlatformAccessToken.mockReturnValue('plat_sa_opaque')
    mockDbAll.mockReturnValue([])

    const res = await buildApp().request('/api/services/replicate/predictions/1', {
      headers: { Authorization: 'Bearer proxy-token' },
    })
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://proxy.test/v1/replicate/predictions/1')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer plat_sa_opaque')
  })

  it('forwards a bodyless POST without a duplex stream body', async () => {
    const res = await buildApp().request('/api/services/replicate/predictions/abc/cancel', {
      method: 'POST',
      headers: { Authorization: 'Bearer proxy-token' },
    })
    expect(res.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { duplex?: string }]
    expect(init.method).toBe('POST')
    expect(init.body).toBeNull()
    expect(init.duplex).toBeUndefined()
  })

  it('forwards Prefer and replaces inbound Authorization', async () => {
    const payload = JSON.stringify({ input: { prompt: 'hi' } })
    const res = await buildApp().request(
      '/api/services/replicate/models/black-forest-labs/flux-dev/predictions',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer proxy-token',
          Prefer: 'wait',
          'Content-Type': 'application/json',
          // Framing must be present: body emptiness is read from Content-Length /
          // Transfer-Encoding (Hono's test client does not synthesize them).
          'Content-Length': String(Buffer.byteLength(payload)),
        },
        body: payload,
      },
    )
    expect(res.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { duplex?: string }]
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('prefer')).toBe('wait')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('authorization')).toBe('Bearer plat_sa_opaque')
    expect(init.body).toBeInstanceOf(ReadableStream)
    expect(init.duplex).toBe('half')
    expect(await new Response(init.body as ReadableStream).text()).toBe(payload)
  })

  it('forwards a bare /replicate path', async () => {
    const res = await buildApp().request('/api/services/replicate', {
      headers: { Authorization: 'Bearer proxy-token' },
    })
    expect(res.status).toBe(200)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://proxy.test/v1/replicate')
  })

  it('preserves encoded path segments and query string', async () => {
    const res = await buildApp().request(
      '/api/services/replicate/models/owner%2Fname/predictions?foo=1&bar=2',
      { headers: { Authorization: 'Bearer proxy-token' } },
    )
    expect(res.status).toBe(200)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://proxy.test/v1/replicate/models/owner%2Fname/predictions?foo=1&bar=2')
  })

  it('streams binary bodies and strips framing headers', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    fetchMock.mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'transfer-encoding': 'chunked',
          'content-length': '4',
          'content-encoding': 'gzip',
          'set-cookie': 'x=1',
          authorization: 'Bearer leaked',
        },
      }),
    )

    const res = await buildApp().request('/api/services/replicate/files/abc', {
      headers: { Authorization: 'Bearer proxy-token' },
    })
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('transfer-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('authorization')).toBeNull()
  })

  it('relays non-2xx upstream status and body unchanged', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Available models: flux-dev' }), {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
          'set-cookie': 'x=1',
        },
      }),
    )

    const res = await buildApp().request('/api/services/replicate/models/_/_', {
      headers: { Authorization: 'Bearer proxy-token' },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ detail: 'Available models: flux-dev' })
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('transfer-encoding')).toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('uses redirect: manual and forwards an abort signal', async () => {
    await buildApp().request('/api/services/replicate/predictions/1', {
      headers: { Authorization: 'Bearer proxy-token' },
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns 499 when the client aborts during upstream fetch', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const signal = (init as RequestInit).signal
      Object.defineProperty(signal!, 'aborted', { configurable: true, get: () => true })
      throw new DOMException('The operation was aborted.', 'AbortError')
    })

    const res = await buildApp().request('/api/services/replicate/predictions/1', {
      headers: { Authorization: 'Bearer proxy-token' },
    })
    expect(res.status).toBe(499)
  })

  it('stamps member attribution on org JWT forwards', async () => {
    const token = orgJwt('org_1')
    mockGetPlatformAccessToken.mockReturnValue(token)
    mockDbAll
      .mockReturnValueOnce([{ userId: 'user_alice' }]) // ACL owner
      .mockReturnValueOnce([{ accountId: 'sub_member_1' }]) // authAccount member

    const res = await buildApp().request('/api/services/replicate/predictions/1', {
      headers: { Authorization: 'Bearer proxy-token' },
    })
    expect(res.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${token}::sub_member_1`)
  })
})

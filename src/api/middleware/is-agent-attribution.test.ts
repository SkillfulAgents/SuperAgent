import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

const mockValidateProxyToken = vi.fn()
const mockIsAuthMode = vi.fn()
const mockGetPlatformAccessToken = vi.fn()
const mockDbAll = vi.fn()

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...a: unknown[]) => mockValidateProxyToken(...a),
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => mockIsAuthMode() }))
vi.mock('@shared/lib/auth/index', () => ({ getAuth: () => ({ api: {} }) }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
  getStoredPlatformMemberId: () => null,
}))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.test',
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
  agentAcl: { userId: 'acl.user_id', agentSlug: 'acl.agent_slug', role: 'acl.role', createdAt: 'acl.created_at' },
  connectedAccounts: {}, remoteMcpServers: {}, notifications: {},
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

import { attribution } from '@shared/lib/platform-attribution'
import {
  _uninstallPlatformFetchInterceptorForTest,
  installPlatformFetchInterceptor,
} from '@shared/lib/platform-attribution/install-fetch-interceptor'
import { IsAgent } from './auth'

function orgJwt(orgId: string): string {
  const header = Buffer.from('{"alg":"none"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ orgId })).toString('base64url')
  return `${header}.${payload}.sig`
}

async function bearerSeenByHandler(): Promise<string | undefined> {
  let seen: string | undefined
  const app = new Hono()
  app.use('*', IsAgent())
  app.get('/x', (c) => {
    seen = attribution.current()?.bearerToken()
    return c.json({ ok: true })
  })
  const res = await app.request('http://localhost/x', {
    headers: { Authorization: 'Bearer proxy-token-abc' },
  })
  expect(res.status).toBe(200)
  return seen
}

const realFetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateProxyToken.mockResolvedValue('my-agent')
  realFetchMock.mockReset()
  realFetchMock.mockResolvedValue(new Response(null, { status: 200 }))
})

afterEach(() => {
  _uninstallPlatformFetchInterceptorForTest()
})

describe('IsAgent attribution scope', () => {
  it('runs the handler under the agent owner attribution scope (org token gets ::memberId)', async () => {
    mockIsAuthMode.mockReturnValue(true)
    mockGetPlatformAccessToken.mockReturnValue(orgJwt('org_1'))
    mockDbAll
      .mockReturnValueOnce([{ userId: 'user_alice' }])
      .mockReturnValueOnce([{ accountId: 'sub_member_1' }])

    expect(await bearerSeenByHandler()).toBe(`${orgJwt('org_1')}::sub_member_1`)
  })

  it('leaves a single-user access key untouched (no agent_acl, no acting member)', async () => {
    mockIsAuthMode.mockReturnValue(false)
    mockGetPlatformAccessToken.mockReturnValue('plat_sa_opaque_key')

    expect(await bearerSeenByHandler()).toBeUndefined()
    expect(mockDbAll).not.toHaveBeenCalled()
  })

  it('opens no scope when the agent has no owner row', async () => {
    mockIsAuthMode.mockReturnValue(true)
    mockGetPlatformAccessToken.mockReturnValue(orgJwt('org_1'))
    mockDbAll.mockReturnValueOnce([])

    expect(await bearerSeenByHandler()).toBeUndefined()
  })

  it('stamps ::memberId onto outbound platform-proxy fetches made inside the handler', async () => {
    mockIsAuthMode.mockReturnValue(true)
    const token = orgJwt('org_1')
    mockGetPlatformAccessToken.mockReturnValue(token)
    mockDbAll
      .mockReturnValueOnce([{ userId: 'user_alice' }])
      .mockReturnValueOnce([{ accountId: 'sub_member_1' }])

    globalThis.fetch = realFetchMock as unknown as typeof fetch
    installPlatformFetchInterceptor()

    const app = new Hono()
    app.use('*', IsAgent())
    app.get('/x', async (c) => {
      await fetch('https://proxy.test/v1/exa/search', { method: 'POST' })
      return c.json({ ok: true })
    })
    const res = await app.request('http://localhost/x', {
      headers: { Authorization: 'Bearer proxy-token-abc' },
    })
    expect(res.status).toBe(200)
    expect(realFetchMock).toHaveBeenCalledTimes(1)
    const [, init] = realFetchMock.mock.calls[0]
    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${token}::sub_member_1`)
  })
})

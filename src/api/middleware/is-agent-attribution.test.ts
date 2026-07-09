import { describe, it, expect, vi, beforeEach } from 'vitest'
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
  agentAcl: { userId: 'acl.user_id', agentSlug: 'acl.agent_slug', role: 'acl.role' },
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
  desc: (col: string) => `DESC(${col})`,
}))

import { attribution } from '@shared/lib/platform-attribution'
import { IsAgent } from './auth'

// An org-scoped runtime JWT: three segments with an `orgId` claim. Only this shape makes the proxy
// require an acting member, so it is the only shape that can expose a missing attribution scope.
function orgJwt(orgId: string): string {
  const header = Buffer.from('{"alg":"none"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ orgId })).toString('base64url')
  return `${header}.${payload}.sig`
}

/** Run a request through the gate and report what the handler sees as its acting bearer. */
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

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateProxyToken.mockResolvedValue('my-agent')
})

describe('IsAgent attribution scope', () => {
  // The proxy bills an org-scoped bearer against the acting member encoded as `<token>::<memberId>`.
  // A container-facing route has no session, so the gate has to supply that member from the agent's
  // owner; without it the platform proxy sees an org token with no seat.
  it('runs the handler under the agent owner attribution scope (org token gets ::memberId)', async () => {
    mockIsAuthMode.mockReturnValue(true)
    mockGetPlatformAccessToken.mockReturnValue(orgJwt('org_1'))
    mockDbAll
      .mockReturnValueOnce([{ userId: 'user_alice' }]) // agent_acl owner
      .mockReturnValueOnce([{ accountId: 'sub_member_1' }]) // alice's platform member

    expect(await bearerSeenByHandler()).toBe(`${orgJwt('org_1')}::sub_member_1`)
  })

  it('leaves a single-user access key untouched (no agent_acl, no acting member)', async () => {
    mockIsAuthMode.mockReturnValue(false)
    mockGetPlatformAccessToken.mockReturnValue('plat_sa_opaque_key')

    // No attribution scope is opened, so the provider's own bearer stands.
    expect(await bearerSeenByHandler()).toBeUndefined()
    expect(mockDbAll).not.toHaveBeenCalled()
  })

  it('opens no scope when the agent has no owner row', async () => {
    mockIsAuthMode.mockReturnValue(true)
    mockGetPlatformAccessToken.mockReturnValue(orgJwt('org_1'))
    mockDbAll.mockReturnValueOnce([]) // no owner

    expect(await bearerSeenByHandler()).toBeUndefined()
  })
})

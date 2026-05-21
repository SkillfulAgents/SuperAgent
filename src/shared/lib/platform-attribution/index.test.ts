import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetPlatformAccessToken = vi.fn()
const mockDbAll = vi.fn()
const orderByCalls: unknown[][] = []

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))

vi.mock('@shared/lib/db', () => {
  const chainable = {
    select: () => chainable,
    from: () => chainable,
    where: () => chainable,
    orderBy: (...args: unknown[]) => {
      orderByCalls.push(args)
      return chainable
    },
    limit: () => chainable,
    all: () => mockDbAll(),
  }
  return { db: chainable }
})

vi.mock('@shared/lib/db/schema', () => ({
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

import {
  attribution,
  decodeOrgIdFromToken,
  runWithAttribution,
  runWithRequestUser,
} from './index'

function buildOrgToken(orgId: string): string {
  const header = Buffer.from('{"alg":"none"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ orgId })).toString('base64url')
  return `${header}.${payload}.sig`
}

const ORG_TOKEN = buildOrgToken('org_test_123')
const ACCESS_KEY = 'opaque_access_key_xyz'

beforeEach(() => {
  vi.clearAllMocks()
  orderByCalls.length = 0
  mockGetPlatformAccessToken.mockReturnValue(ORG_TOKEN)
  mockDbAll.mockReturnValue([{ accountId: 'sub_user_123' }])
})

describe('decodeOrgIdFromToken', () => {
  it('returns the orgId from a 3-segment JWT-shaped token', () => {
    expect(decodeOrgIdFromToken(buildOrgToken('org_42'))).toBe('org_42')
  })

  it('returns null for opaque tokens (not three segments)', () => {
    expect(decodeOrgIdFromToken('opaque-key')).toBeNull()
  })

  it('returns null when payload has no orgId claim', () => {
    const header = Buffer.from('{"alg":"none"}').toString('base64url')
    const payload = Buffer.from('{}').toString('base64url')
    expect(decodeOrgIdFromToken(`${header}.${payload}.sig`)).toBeNull()
  })
})

describe('attribution.fromCurrentRequest', () => {
  it('resolves the acting user from the request scope', async () => {
    await runWithRequestUser('user_request_xyz', () => {
      const auth = attribution.fromCurrentRequest()
      const headers = new Headers()
      auth?.applyTo(headers)

      expect(headers.get('Authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_user_123`)
      expect(auth?.bearerToken()).toBe(`${ORG_TOKEN}::sub_user_123`)
      expect(auth?.getKey()).toBe('member:sub_user_123')
    })
  })

  it('returns null when called outside a request scope', () => {
    expect(attribution.fromCurrentRequest()).toBeNull()
  })
})

describe('attribution.fromUserId', () => {
  it('builds attribution for an explicit userId', () => {
    const auth = attribution.fromUserId('user_alice')
    const headers = new Headers()
    auth?.applyTo(headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_user_123`)
  })
})

describe('attribution.fromResourceCreator', () => {
  it('builds attribution from a connection creator userId', () => {
    const auth = attribution.fromResourceCreator('user_alice')
    expect(auth?.getKey()).toBe('member:sub_user_123')
  })

  it('returns null when the creator is missing', () => {
    expect(attribution.fromResourceCreator(null)).toBeNull()
  })
})

describe('attribution.current', () => {
  it('prefers the runWithAttribution scope', async () => {
    const scoped = attribution.fromUserId('user_scoped')!
    await runWithAttribution(scoped, () => {
      expect(attribution.current()).toBe(scoped)
    })
  })

  it('falls back to the request-user scope', async () => {
    await runWithRequestUser('user_xyz', () => {
      expect(attribution.current()).not.toBeNull()
    })
  })

  it('returns null when neither scope is active', () => {
    expect(attribution.current()).toBeNull()
  })
})

describe('access-key path', () => {
  beforeEach(() => mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY))

  it('passes the access key through unchanged and uses the access_key cache key', () => {
    const auth = attribution.fromUserId('user_alice')
    const headers = new Headers()
    auth?.applyTo(headers)

    expect(headers.get('Authorization')).toBe(`Bearer ${ACCESS_KEY}`)
    expect(auth?.bearerToken()).toBe(ACCESS_KEY)
    expect(auth?.getKey()).toBe('access_key')
  })

  it('builds an attribution even when memberId is null', () => {
    mockDbAll.mockReturnValue([])
    expect(attribution.fromResourceCreator('local')?.getKey()).toBe('access_key')
  })
})

describe('refusals', () => {
  it('returns null when no platform token is configured', () => {
    mockGetPlatformAccessToken.mockReturnValue(null)
    expect(attribution.fromUserId('user_alice')).toBeNull()
  })

  it('refuses org-scoped tokens without a memberId', () => {
    mockDbAll.mockReturnValue([])
    expect(attribution.fromUserId('user_orphan')).toBeNull()
  })
})

describe('member-lookup query (via attribution.fromUserId)', () => {
  it('queries the newest linked platform account', () => {
    attribution.fromUserId('user_1')
    expect(mockDbAll).toHaveBeenCalledTimes(1)
    expect(orderByCalls).toEqual([['DESC(account.updated_at)']])
  })
})

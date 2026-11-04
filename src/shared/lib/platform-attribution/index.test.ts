import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetPlatformAccessToken = vi.fn()
const mockGetStoredPlatformMemberId = vi.fn((): string | null => null)
const mockDbAll = vi.fn()
const orderByCalls: unknown[][] = []

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: async () => mockGetPlatformAccessToken(),
  getStoredPlatformMemberId: async () => mockGetStoredPlatformMemberId(),
  // From settings the caller read: the stored connection's token and member.
  platformAccessTokenFrom: (settings: { platformAuth?: { token?: string } }) => settings.platformAuth?.token ?? null,
  storedPlatformMemberIdFrom: (settings: { platformAuth?: { memberId?: string } }) => settings.platformAuth?.memberId ?? null,
}))

const mockGetAgentOwnerUserId = vi.fn((_slug: string): string | null => null)
vi.mock('@shared/lib/services/agent-owner', () => ({
  getAgentOwnerUserId: (slug: string) => mockGetAgentOwnerUserId(slug),
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
import { forgetRequestScopedAttribution } from './request-context'

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
  it('returns the orgId from a 3-segment JWT-shaped token', async () => {
    expect(decodeOrgIdFromToken(buildOrgToken('org_42'))).toBe('org_42')
  })

  it('returns null for opaque tokens (not three segments)', async () => {
    expect(decodeOrgIdFromToken('opaque-key')).toBeNull()
  })

  it('returns null when payload has no orgId claim', async () => {
    const header = Buffer.from('{"alg":"none"}').toString('base64url')
    const payload = Buffer.from('{}').toString('base64url')
    expect(decodeOrgIdFromToken(`${header}.${payload}.sig`)).toBeNull()
  })
})

describe('attribution.requiresActingMember', () => {
  it('is true for an org-scoped JWT', async () => {
    mockGetPlatformAccessToken.mockReturnValue(ORG_TOKEN)
    expect(await attribution.requiresActingMember()).toBe(true)
  })

  it('is false for an opaque access key', async () => {
    mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY)
    expect(await attribution.requiresActingMember()).toBe(false)
  })

  it('is false when no platform token is configured', async () => {
    mockGetPlatformAccessToken.mockReturnValue(null)
    expect(await attribution.requiresActingMember()).toBe(false)
  })
})

describe('attribution.fromCurrentRequest', () => {
  it('resolves the acting user from the request scope', async () => {
    await runWithRequestUser('user_request_xyz', async () => {
      const auth = (await attribution.fromCurrentRequest())
      const headers = new Headers()
      auth?.applyTo(headers)

      expect(headers.get('Authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_user_123`)
      expect(auth?.bearerToken()).toBe(`${ORG_TOKEN}::sub_user_123`)
      expect(auth?.getKey()).toBe('member:sub_user_123')
    })
  })

  it('returns null when called outside a request scope', async () => {
    expect((await attribution.fromCurrentRequest())).toBeNull()
  })
})

describe('attribution.fromUserId', () => {
  it('builds attribution for an explicit userId', async () => {
    const auth = (await attribution.fromUserId('user_alice'))
    const headers = new Headers()
    auth?.applyTo(headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_user_123`)
  })
})

describe('attribution.fromResourceCreator', () => {
  it('builds attribution from a connection creator userId', async () => {
    const auth = (await attribution.fromResourceCreator('user_alice'))
    expect(auth?.getKey()).toBe('member:sub_user_123')
  })

  it('returns null when the creator is missing', async () => {
    expect((await attribution.fromResourceCreator(null))).toBeNull()
  })
})

describe('attribution.current', () => {
  it('prefers the runWithAttribution scope', async () => {
    const scoped = (await attribution.fromUserId('user_scoped'))!
    await runWithAttribution(scoped, async () => {
      expect((await attribution.current())).toBe(scoped)
    })
  })

  it('falls back to the request-user scope', async () => {
    await runWithRequestUser('user_xyz', async () => {
      expect((await attribution.current())).not.toBeNull()
    })
  })

  it('returns null when neither scope is active', async () => {
    expect((await attribution.current())).toBeNull()
  })
})

describe('attribution.current within one request', () => {
  /** One resolution = one member lookup + one token read. */
  const resolutions = () => mockDbAll.mock.calls.length

  it('resolves once for every platform call in the request, concurrent ones sharing the resolution in flight', async () => {
    await runWithRequestUser('user_1', async () => {
      const concurrent = await Promise.all(Array.from({ length: 5 }, () => attribution.current()))
      const later = await attribution.current()
      expect(new Set([...concurrent, later]).size).toBe(1)
    })
    expect(resolutions()).toBe(1)
    expect(mockGetPlatformAccessToken).toHaveBeenCalledTimes(1)
  })

  it('resolves afresh in the next request', async () => {
    await runWithRequestUser('user_1', async () => {
      await attribution.current()
    })
    mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY)
    await runWithRequestUser('user_1', async () => {
      expect((await attribution.current())?.bearerToken()).toBe(ACCESS_KEY)
    })
    expect(resolutions()).toBe(2)
  })

  it('work the request left running resolves afresh once the request is over', async () => {
    let release!: () => void
    let lingering!: Promise<string | undefined>
    await runWithRequestUser('user_1', async () => {
      await attribution.current()
      // A continuation registered in the request (a listener, fire-and-forget
      // work): it runs later, still in the request's scope.
      const later = new Promise<void>((resolve) => { release = resolve })
      lingering = later.then(async () => (await attribution.current())?.bearerToken())
    })
    // The connection changes after the request ended; the leftover work must not use the request's memo.
    mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY)
    release()
    expect(await lingering).toBe(ACCESS_KEY)
    expect(resolutions()).toBe(2)
  })

  it('resolves afresh after the request saves or removes the platform connection', async () => {
    await runWithRequestUser('user_1', async () => {
      expect((await attribution.current())?.bearerToken()).toBe(`${ORG_TOKEN}::sub_user_123`)
      mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY)
      // What savePlatformAuth and the revoke path do once their write lands.
      forgetRequestScopedAttribution()
      expect((await attribution.current())?.bearerToken()).toBe(ACCESS_KEY)
    })
    expect(resolutions()).toBe(2)
  })

  it('does not keep a failed resolution', async () => {
    mockDbAll.mockImplementationOnce(() => { throw new Error('database is locked') })
    await runWithRequestUser('user_1', async () => {
      await expect(attribution.current()).rejects.toThrow('database is locked')
      expect((await attribution.current())?.getKey()).toBe('member:sub_user_123')
    })
  })

  it('keeps an inner request scope separate from the outer one', async () => {
    await runWithRequestUser('user_outer', async () => {
      await attribution.current()
      await runWithRequestUser('user_inner', async () => {
        await attribution.current()
      })
      await attribution.current()
    })
    expect(resolutions()).toBe(2)
  })
})

describe('attribution builders given the settings their operation read', () => {
  it('builds from those settings without reading the connection again', async () => {
    const settings = { platformAuth: { token: ACCESS_KEY } } as never
    const auth = await attribution.fromUserId('user_alice', settings)
    expect(auth?.bearerToken()).toBe(ACCESS_KEY)
    expect(await attribution.requiresActingMember(settings)).toBe(false)
    expect(mockGetPlatformAccessToken).not.toHaveBeenCalled()
    expect(mockGetStoredPlatformMemberId).not.toHaveBeenCalled()
  })
})

describe('attribution.forAgent (container cold start)', () => {
  beforeEach(() => {
    mockGetAgentOwnerUserId.mockReturnValue(null)
    mockGetStoredPlatformMemberId.mockReturnValue(null)
  })

  it('prefers the ambient request user over the agent owner', async () => {
    mockGetAgentOwnerUserId.mockReturnValue('user_owner')
    await runWithRequestUser('user_request', async () => {
      (await attribution.forAgent('agent_a'))
      expect(mockGetAgentOwnerUserId).not.toHaveBeenCalled()
    })
  })

  it('prefers an explicit runWithAttribution scope', async () => {
    const scoped = (await attribution.fromUserId('user_scoped'))!
    await runWithAttribution(scoped, async () => {
      expect((await attribution.forAgent('agent_a'))).toBe(scoped)
    })
  })

  it('falls back to the agent owner when no scope is active', async () => {
    mockGetAgentOwnerUserId.mockReturnValue('user_owner')
    const auth = (await attribution.forAgent('agent_a'))
    expect(mockGetAgentOwnerUserId).toHaveBeenCalledWith('agent_a')
    expect(auth?.bearerToken()).toBe(`${ORG_TOKEN}::sub_user_123`)
  })

  it('falls back to the stored member when the agent has no owner', async () => {
    mockGetStoredPlatformMemberId.mockReturnValue('sub_settings_789')
    expect((await attribution.forAgent('agent_a'))?.bearerToken()).toBe(`${ORG_TOKEN}::sub_settings_789`)
  })

  it('falls back to the stored member when the owner has no platform account', async () => {
    mockGetAgentOwnerUserId.mockReturnValue('user_orphan')
    mockDbAll.mockReturnValue([])
    mockGetStoredPlatformMemberId.mockReturnValue('sub_settings_789')
    expect((await attribution.forAgent('agent_a'))?.bearerToken()).toBe(`${ORG_TOKEN}::sub_settings_789`)
  })

  it('returns null for an org token when nothing in the chain resolves a member', async () => {
    mockDbAll.mockReturnValue([])
    expect((await attribution.forAgent('agent_a'))).toBeNull()
  })

  it('returns a member-less attribution for an opaque access key', async () => {
    mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY)
    expect((await attribution.forAgent('agent_a'))?.bearerToken()).toBe(ACCESS_KEY)
  })
})

describe('access-key path', () => {
  beforeEach(() => mockGetPlatformAccessToken.mockReturnValue(ACCESS_KEY))

  it('passes the access key through unchanged and uses the access_key cache key', async () => {
    const auth = (await attribution.fromUserId('user_alice'))
    const headers = new Headers()
    auth?.applyTo(headers)

    expect(headers.get('Authorization')).toBe(`Bearer ${ACCESS_KEY}`)
    expect(auth?.bearerToken()).toBe(ACCESS_KEY)
    expect(auth?.getKey()).toBe('access_key')
  })

  it('builds an attribution even when memberId is null', async () => {
    mockDbAll.mockReturnValue([])
    expect((await attribution.fromResourceCreator('local'))?.getKey()).toBe('access_key')
  })
})

describe('refusals', () => {
  it('returns null when no platform token is configured', async () => {
    mockGetPlatformAccessToken.mockReturnValue(null)
    expect((await attribution.fromUserId('user_alice'))).toBeNull()
  })

  it('refuses org-scoped tokens without a memberId', async () => {
    mockDbAll.mockReturnValue([])
    expect((await attribution.fromUserId('user_orphan'))).toBeNull()
  })

  it('falls back to the settings-stored memberId when no authAccount row exists', async () => {
    mockDbAll.mockReturnValue([])
    mockGetStoredPlatformMemberId.mockReturnValue('sub_settings_789')
    const auth = (await attribution.fromUserId('user_orphan'))
    expect(auth?.bearerToken()).toBe(`${ORG_TOKEN}::sub_settings_789`)
    expect(auth?.getKey()).toBe('member:sub_settings_789')
  })
})

describe('member-lookup query (via attribution.fromUserId)', () => {
  it('queries the newest linked platform account', async () => {
    (await attribution.fromUserId('user_1'))
    expect(mockDbAll).toHaveBeenCalledTimes(1)
    expect(orderByCalls).toEqual([['DESC(account.updated_at)']])
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockIsAuthMode = vi.fn<() => boolean>()
const mockAll = vi.fn()
const whereArgs: unknown[] = []
const orderByArgs: unknown[] = []

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => mockIsAuthMode() }))
vi.mock('@shared/lib/db', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: (...a: unknown[]) => {
      whereArgs.push(...a)
      return chain
    },
    orderBy: (...a: unknown[]) => {
      orderByArgs.push(...a)
      return chain
    },
    limit: () => chain,
    all: () => mockAll(),
  }
  return { db: chain }
})
vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: {
    userId: 'acl.user_id',
    agentSlug: 'acl.agent_slug',
    role: 'acl.role',
    createdAt: 'acl.created_at',
  },
}))
vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => `${col}=${val}`,
  and: (...args: string[]) => args.join(' AND '),
  asc: (col: string) => `asc(${col})`,
}))

import { getAgentOwnerUserId } from './agent-owner'

beforeEach(() => {
  vi.clearAllMocks()
  whereArgs.length = 0
  orderByArgs.length = 0
})

describe('getAgentOwnerUserId', () => {
  it('returns the owner user id in auth mode', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockAll.mockReturnValue([{ userId: 'user_alice' }])
    expect(getAgentOwnerUserId('my-agent')).toBe('user_alice')
  })

  // agent_acl also holds 'user' and 'viewer' rows; attributing spend to a viewer would be wrong.
  it('filters on the owner role and the requested agent', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockAll.mockReturnValue([{ userId: 'user_alice' }])
    getAgentOwnerUserId('my-agent')
    expect(whereArgs.join(' ')).toContain('acl.agent_slug=my-agent')
    expect(whereArgs.join(' ')).toContain('acl.role=owner')
  })

  // An agent can have several owners. The FIRST one is the acting member on billed proxy calls, and
  // the billing gate reads a per-seat subscription — so an unordered pick could silently flip a
  // request to a 402 when a co-owner is added or removed.
  it('picks the first owner by createdAt, not an arbitrary row', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockAll.mockReturnValue([{ userId: 'user_alice' }])
    getAgentOwnerUserId('my-agent')
    expect(orderByArgs).toEqual(['asc(acl.created_at)'])
  })

  it('returns null when the agent has no owner row', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockAll.mockReturnValue([])
    expect(getAgentOwnerUserId('orphan-agent')).toBeNull()
  })

  // A single-user install has no agent_acl rows at all; it must not pay for a query, and its
  // platform credential is already member-scoped so it wants no acting member anyway.
  it('short-circuits without querying outside auth mode', () => {
    mockIsAuthMode.mockReturnValue(false)
    expect(getAgentOwnerUserId('my-agent')).toBeNull()
    expect(mockAll).not.toHaveBeenCalled()
  })
})

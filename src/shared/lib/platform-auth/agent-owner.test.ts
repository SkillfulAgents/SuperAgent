import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDbAll = vi.fn()
const orderByCalls: unknown[][] = []

vi.mock('@shared/lib/db', () => {
  const chainable = {
    select: () => chainable,
    from: () => chainable,
    innerJoin: () => chainable,
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
  agentAcl: {
    userId: 'agent_acl.user_id',
    agentSlug: 'agent_acl.agent_slug',
    role: 'agent_acl.role',
    createdAt: 'agent_acl.created_at',
  },
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
  asc: (col: string) => `ASC(${col})`,
  desc: (col: string) => `DESC(${col})`,
}))

import { getOwnerAccountIdForProvider } from './agent-owner'

describe('getOwnerAccountIdForProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    orderByCalls.length = 0
  })

  it('returns accountId resolved from agent_acl(owner) → provider account', () => {
    mockDbAll.mockReturnValue([{ accountId: 'sub_abc123' }])

    expect(getOwnerAccountIdForProvider('my-agent', 'platform')).toBe('sub_abc123')
    expect(mockDbAll).toHaveBeenCalledTimes(1)
  })

  it('returns null when no owner is registered for the agent', () => {
    mockDbAll.mockReturnValue([])

    expect(getOwnerAccountIdForProvider('orphan-agent', 'platform')).toBeNull()
  })

  it('returns null when owner exists but has no matching provider account', () => {
    // innerJoin with the requested providerId filters out credential-only users,
    // which presents to the caller as an empty result set.
    mockDbAll.mockReturnValue([])

    expect(getOwnerAccountIdForProvider('credential-owner-agent', 'platform')).toBeNull()
  })

  it('orders by oldest owner ACL first, then most-recently-refreshed provider account', () => {
    mockDbAll.mockReturnValue([{ accountId: 'sub_first_owner' }])

    getOwnerAccountIdForProvider('multi-owner-agent', 'platform')

    expect(orderByCalls).toEqual([
      ['ASC(agent_acl.created_at)', 'DESC(account.updated_at)'],
    ])
  })

  it('queries the DB on every call (no stale cache after ACL mutations)', () => {
    mockDbAll
      .mockReturnValueOnce([{ accountId: 'sub_alice' }])
      .mockReturnValueOnce([{ accountId: 'sub_bob' }])

    expect(getOwnerAccountIdForProvider('agent-x', 'platform')).toBe('sub_alice')
    expect(getOwnerAccountIdForProvider('agent-x', 'platform')).toBe('sub_bob')
    expect(mockDbAll).toHaveBeenCalledTimes(2)
  })
})

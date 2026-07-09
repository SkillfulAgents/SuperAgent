import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockIsAuthMode = vi.fn<() => boolean>()
const mockAll = vi.fn()
const whereArgs: unknown[] = []

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => mockIsAuthMode() }))
vi.mock('@shared/lib/db', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: (...a: unknown[]) => {
      whereArgs.push(...a)
      return chain
    },
    limit: () => chain,
    all: () => mockAll(),
  }
  return { db: chain }
})
vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: { userId: 'acl.user_id', agentSlug: 'acl.agent_slug', role: 'acl.role' },
}))
vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => `${col}=${val}`,
  and: (...args: string[]) => args.join(' AND '),
}))

import { getAgentOwnerUserId } from './agent-owner'

beforeEach(() => {
  vi.clearAllMocks()
  whereArgs.length = 0
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

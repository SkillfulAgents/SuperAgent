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
  it('returns the first owner by createdAt, filtered to owner role + agent', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockAll.mockReturnValue([{ userId: 'user_alice' }])
    expect(getAgentOwnerUserId('my-agent')).toBe('user_alice')
    expect(whereArgs.join(' ')).toContain('acl.agent_slug=my-agent')
    expect(whereArgs.join(' ')).toContain('acl.role=owner')
    expect(orderByArgs).toEqual(['asc(acl.created_at)'])
  })

  it('returns null when the agent has no owner row', () => {
    mockIsAuthMode.mockReturnValue(true)
    mockAll.mockReturnValue([])
    expect(getAgentOwnerUserId('orphan-agent')).toBeNull()
  })

  it('short-circuits without querying outside auth mode', () => {
    mockIsAuthMode.mockReturnValue(false)
    expect(getAgentOwnerUserId('my-agent')).toBeNull()
    expect(mockAll).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Track delete calls to verify which sessions are removed
const deletedSessionIds: string[] = []

// Configurable session list returned by the mock DB
let mockSessions: { id: string; createdAt: Date }[] = []

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}))

vi.mock('@shared/lib/db/schema', () => ({
  authSession: {
    id: 'id',
    createdAt: 'createdAt',
    userId: 'userId',
  },
}))

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            all: () => mockSessions,
          }),
        }),
      }),
    }),
    delete: () => ({
      where: (condition: { val: string }) => ({
        run: () => {
          deletedSessionIds.push(condition.val)
        },
      }),
    }),
  },
}))

import { enforceMaxConcurrentSessions } from './session-enforcement'

describe('enforceMaxConcurrentSessions', () => {
  beforeEach(() => {
    mockSessions = []
    deletedSessionIds.length = 0
  })

  it('does nothing when sessions are within limit', () => {
    mockSessions = [
      { id: 's1', createdAt: new Date('2025-01-01') },
      { id: 's2', createdAt: new Date('2025-01-02') },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 3)
    expect(deleted).toBe(0)
    expect(deletedSessionIds).toEqual([])
  })

  it('does nothing when sessions are exactly at the limit', () => {
    mockSessions = [
      { id: 's1', createdAt: new Date('2025-01-01') },
      { id: 's2', createdAt: new Date('2025-01-02') },
      { id: 's3', createdAt: new Date('2025-01-03') },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 3)
    expect(deleted).toBe(0)
    expect(deletedSessionIds).toEqual([])
  })

  it('deletes oldest session when one over limit', () => {
    mockSessions = [
      { id: 's1', createdAt: new Date('2025-01-01') },
      { id: 's2', createdAt: new Date('2025-01-02') },
      { id: 's3', createdAt: new Date('2025-01-03') },
      { id: 's4', createdAt: new Date('2025-01-04') },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 3)
    expect(deleted).toBe(1)
    expect(deletedSessionIds).toEqual(['s1'])
  })

  it('deletes multiple oldest sessions when several over limit', () => {
    mockSessions = [
      { id: 's1', createdAt: new Date('2025-01-01') },
      { id: 's2', createdAt: new Date('2025-01-02') },
      { id: 's3', createdAt: new Date('2025-01-03') },
      { id: 's4', createdAt: new Date('2025-01-04') },
      { id: 's5', createdAt: new Date('2025-01-05') },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 2)
    expect(deleted).toBe(3)
    expect(deletedSessionIds).toEqual(['s1', 's2', 's3'])
  })

  it('handles maxSessions of 1', () => {
    mockSessions = [
      { id: 's1', createdAt: new Date('2025-01-01') },
      { id: 's2', createdAt: new Date('2025-01-02') },
      { id: 's3', createdAt: new Date('2025-01-03') },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 1)
    expect(deleted).toBe(2)
    expect(deletedSessionIds).toEqual(['s1', 's2'])
  })

  it('handles empty sessions list', () => {
    mockSessions = []

    const deleted = enforceMaxConcurrentSessions('user1', 5)
    expect(deleted).toBe(0)
    expect(deletedSessionIds).toEqual([])
  })
})

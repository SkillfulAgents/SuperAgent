import { describe, it, expect, vi, beforeEach } from 'vitest'

// Track delete calls to verify which sessions are removed
const deletedSessionIds: string[] = []

// Configurable session list returned by the mock DB. `creationMethod` is
// optional so the pre-existing cases below still read as plain session lists.
let mockSessions: { id: string; createdAt: Date; creationMethod?: string | null }[] = []

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}))

vi.mock('@shared/lib/db/schema', () => ({
  authSession: {
    id: 'id',
    createdAt: 'createdAt',
    userId: 'userId',
    creationMethod: 'creationMethod',
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

  it('counts sessions created before the creationMethod column as capped', () => {
    // Null is what every row written before this column existed reads as.
    // Treating those as exempt would silently uncap an entire installed base.
    mockSessions = [
      { id: 's1', createdAt: new Date('2025-01-01'), creationMethod: null },
      { id: 's2', createdAt: new Date('2025-01-02'), creationMethod: null },
      { id: 's3', createdAt: new Date('2025-01-03'), creationMethod: null },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 2)
    expect(deleted).toBe(1)
    expect(deletedSessionIds).toEqual(['s1'])
  })
})

describe('enforceMaxConcurrentSessions — token-exchange exemption', () => {
  beforeEach(() => {
    mockSessions = []
    deletedSessionIds.length = 0
  })

  it('never evicts a token-exchange session, even as the oldest', () => {
    // The exact regression: the installed client's session is the oldest, so
    // oldest-first eviction would take it and the client would re-mint on its
    // next call — evicting another browser session, indefinitely.
    mockSessions = [
      { id: 'desktop', createdAt: new Date('2025-01-01'), creationMethod: 'token-exchange' },
      { id: 's2', createdAt: new Date('2025-01-02'), creationMethod: 'password' },
      { id: 's3', createdAt: new Date('2025-01-03'), creationMethod: 'password' },
      { id: 's4', createdAt: new Date('2025-01-04'), creationMethod: 'password' },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 2)
    expect(deleted).toBe(1)
    expect(deletedSessionIds).toEqual(['s2'])
  })

  it('does not let a token-exchange session push a browser session out', () => {
    // Three interactive sessions under a cap of three. Adding the desktop
    // client must not put the user over — otherwise installing the app costs
    // them a browser session.
    mockSessions = [
      { id: 's1', createdAt: new Date('2025-01-01'), creationMethod: 'password' },
      { id: 's2', createdAt: new Date('2025-01-02'), creationMethod: 'oidc' },
      { id: 's3', createdAt: new Date('2025-01-03'), creationMethod: 'password' },
      { id: 'desktop', createdAt: new Date('2025-01-04'), creationMethod: 'token-exchange' },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 3)
    expect(deleted).toBe(0)
    expect(deletedSessionIds).toEqual([])
  })

  it('leaves several token-exchange sessions alone regardless of the cap', () => {
    // A user with the app on more than one machine. None of them counts, and
    // none of them is a candidate — even at a cap of one.
    mockSessions = [
      { id: 'laptop', createdAt: new Date('2025-01-01'), creationMethod: 'token-exchange' },
      { id: 'desktop', createdAt: new Date('2025-01-02'), creationMethod: 'token-exchange' },
      { id: 's3', createdAt: new Date('2025-01-03'), creationMethod: 'password' },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 1)
    expect(deleted).toBe(0)
    expect(deletedSessionIds).toEqual([])
  })

  it('still caps other methods, including impersonation', () => {
    // The exemption is for one method, not a general "leave sessions alone".
    mockSessions = [
      { id: 's1', createdAt: new Date('2025-01-01'), creationMethod: 'impersonation' },
      { id: 's2', createdAt: new Date('2025-01-02'), creationMethod: 'unknown' },
      { id: 's3', createdAt: new Date('2025-01-03'), creationMethod: 'oidc' },
      { id: 'desktop', createdAt: new Date('2025-01-04'), creationMethod: 'token-exchange' },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 1)
    expect(deleted).toBe(2)
    expect(deletedSessionIds).toEqual(['s1', 's2'])
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Track delete calls to verify which sessions are removed
const deletedSessionIds: string[] = []

// Configurable session list returned by the mock DB. `creationMethod` and
// `expiresAt` are optional so the pre-existing cases below still read as plain
// session lists; a row with no expiry counts as live.
let mockSessions: {
  id: string
  createdAt: Date
  expiresAt?: Date
  creationMethod?: string | null
}[] = []

const HOUR = 60 * 60 * 1000
const past = (hours: number) => new Date(Date.now() - hours * HOUR)
const future = (hours: number) => new Date(Date.now() + hours * HOUR)

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}))

vi.mock('@shared/lib/db/schema', () => ({
  authSession: {
    id: 'id',
    createdAt: 'createdAt',
    expiresAt: 'expiresAt',
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

describe('enforceMaxConcurrentSessions — non-interactive sessions', () => {
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

  it('holds several token-exchange sessions clear of the interactive cap', () => {
    // A user with the app on more than one machine. None of them counts
    // against the interactive cap, or is a candidate for it — even at a cap
    // of one. They are bounded by their own ceiling instead.
    mockSessions = [
      { id: 'laptop', createdAt: new Date('2025-01-01'), creationMethod: 'token-exchange' },
      { id: 'desktop', createdAt: new Date('2025-01-02'), creationMethod: 'token-exchange' },
      { id: 's3', createdAt: new Date('2025-01-03'), creationMethod: 'password' },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 1)
    expect(deleted).toBe(0)
    expect(deletedSessionIds).toEqual([])
  })

  it('prunes expired token-exchange sessions', () => {
    // Nothing else in the codebase deletes expired sessions, and a client
    // re-mints on a schedule — so without this, exempting them from the
    // interactive cap would mean a row per re-mint, forever.
    mockSessions = [
      { id: 'dead1', createdAt: past(3), expiresAt: past(2), creationMethod: 'token-exchange' },
      { id: 'dead2', createdAt: past(2), expiresAt: past(1), creationMethod: 'token-exchange' },
      { id: 'live', createdAt: past(1), expiresAt: future(1), creationMethod: 'token-exchange' },
      { id: 's1', createdAt: past(1), expiresAt: future(1), creationMethod: 'password' },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 5)
    expect(deleted).toBe(2)
    expect(deletedSessionIds.sort()).toEqual(['dead1', 'dead2'])
  })

  it('bounds live token-exchange sessions by their own ceiling, oldest first', () => {
    // The backstop: even with nothing expiring, the table cannot grow forever.
    mockSessions = Array.from({ length: 13 }, (_, i) => ({
      id: `x${i}`,
      createdAt: past(20 - i),
      expiresAt: future(1),
      creationMethod: 'token-exchange',
    }))

    const deleted = enforceMaxConcurrentSessions('user1', 5)
    expect(deleted).toBe(3)
    expect(deletedSessionIds).toEqual(['x0', 'x1', 'x2'])
  })

  it('does not let expired exchange rows consume the interactive cap', () => {
    // Pruning them must not evict a browser session as a side effect.
    mockSessions = [
      { id: 'dead', createdAt: past(3), expiresAt: past(2), creationMethod: 'token-exchange' },
      { id: 's1', createdAt: past(2), expiresAt: future(1), creationMethod: 'password' },
      { id: 's2', createdAt: past(1), expiresAt: future(1), creationMethod: 'password' },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 2)
    expect(deleted).toBe(1)
    expect(deletedSessionIds).toEqual(['dead'])
  })

  it('leaves expired interactive sessions counted, as before', () => {
    // Deliberately unchanged: those rows are counted today, so dropping them
    // would change the effective cap for every existing deployment. Separate
    // decision, separate change.
    mockSessions = [
      { id: 's1', createdAt: past(3), expiresAt: past(2), creationMethod: 'password' },
      { id: 's2', createdAt: past(2), expiresAt: future(1), creationMethod: 'password' },
      { id: 's3', createdAt: past(1), expiresAt: future(1), creationMethod: 'password' },
    ]

    const deleted = enforceMaxConcurrentSessions('user1', 2)
    expect(deleted).toBe(1)
    expect(deletedSessionIds).toEqual(['s1'])
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

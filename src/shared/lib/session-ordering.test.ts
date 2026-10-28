import { describe, expect, it } from 'vitest'
import { sortSessionsByActivity } from './session-ordering'

describe('sortSessionsByActivity', () => {
  const sessions = [
    {
      id: 'newer-created',
      createdAt: '2026-08-25T12:00:00.000Z',
      lastActivityAt: '2026-08-25T12:00:00.000Z',
    },
    {
      id: 'created-fallback',
      createdAt: '2026-08-24T12:00:00.000Z',
      lastActivityAt: 'invalid',
    },
    {
      id: 'recently-active',
      createdAt: '2026-08-23T12:00:00.000Z',
      lastActivityAt: '2026-08-26T12:00:00.000Z',
    },
  ]

  it('orders newest activity first without mutating the input', () => {
    const originalIds = sessions.map(({ id }) => id)

    expect(sortSessionsByActivity(sessions).map(({ id }) => id))
      .toEqual(['recently-active', 'newer-created', 'created-fallback'])
    expect(sessions.map(({ id }) => id)).toEqual(originalIds)
  })

  it('supports oldest activity first', () => {
    expect(sortSessionsByActivity(sessions, 'oldest').map(({ id }) => id))
      .toEqual(['created-fallback', 'newer-created', 'recently-active'])
  })

  it('accepts Date values and breaks equal timestamps by id', () => {
    const tied = sortSessionsByActivity([
      { id: 'z-session', createdAt: new Date('2026-08-26T12:00:00.000Z') },
      { id: 'a-session', createdAt: new Date('2026-08-26T12:00:00.000Z') },
    ])

    expect(tied.map(({ id }) => id)).toEqual(['a-session', 'z-session'])
  })

  it('can prioritize waiting while preserving date fallback and tie-breaking within each group', () => {
    const waiting = [
      { id: 'z-waiting', createdAt: '2026-08-20', lastActivityAt: 'invalid', isAwaitingInput: true },
      { id: 'a-waiting', createdAt: '2026-08-20', isAwaitingInput: true },
      { id: 'new-waiting', createdAt: '2026-08-21', isAwaitingInput: true },
    ]
    const all = [...sessions, ...waiting]
    expect(sortSessionsByActivity(all, 'newest', { awaitingFirst: true }).map(({ id }) => id)).toEqual([
      'new-waiting', 'a-waiting', 'z-waiting', 'recently-active', 'newer-created', 'created-fallback',
    ])
    expect(sortSessionsByActivity(all, 'oldest', { awaitingFirst: true }).map(({ id }) => id)).toEqual([
      'a-waiting', 'z-waiting', 'new-waiting', 'created-fallback', 'newer-created', 'recently-active',
    ])
    expect(sortSessionsByActivity(all)[0].id).toBe('recently-active')
  })
})

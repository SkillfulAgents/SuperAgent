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
})

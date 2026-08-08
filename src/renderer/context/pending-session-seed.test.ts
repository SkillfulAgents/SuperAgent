import { describe, it, expect, beforeEach } from 'vitest'
import {
  seedPendingSessionMessage,
  peekPendingSessionSeed,
  clearPendingSessionSeed,
  clearPendingSessionSeeds,
} from './pending-session-seed'

describe('pending-session-seed', () => {
  beforeEach(() => {
    clearPendingSessionSeeds()
  })

  it('keeps a seed available until it is explicitly cleared', () => {
    seedPendingSessionMessage('sess-1', 'Hello agent', 'msg-uuid')
    const first = peekPendingSessionSeed('sess-1')
    expect(first).toMatchObject({
      localId: 'msg-uuid',
      uuid: 'msg-uuid',
      text: 'Hello agent',
    })
    expect(peekPendingSessionSeed('sess-1')).toBe(first)
    clearPendingSessionSeed('sess-1')
    expect(peekPendingSessionSeed('sess-1')).toBeUndefined()
  })

  it('includes optional sender', () => {
    seedPendingSessionMessage('sess-1', 'Hi', 'u1', {
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
    })
    expect(peekPendingSessionSeed('sess-1')?.sender).toEqual({
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
    })
  })

  it('returns undefined for an unknown session', () => {
    expect(peekPendingSessionSeed('missing')).toBeUndefined()
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import {
  seedPendingSessionMessage,
  takePendingSessionSeed,
  clearPendingSessionSeeds,
} from './pending-session-seed'

describe('pending-session-seed', () => {
  beforeEach(() => {
    clearPendingSessionSeeds()
  })

  it('stores a seed that takePendingSessionSeed returns once', () => {
    seedPendingSessionMessage('sess-1', 'Hello agent', 'msg-uuid')
    const first = takePendingSessionSeed('sess-1')
    expect(first).toMatchObject({
      localId: 'msg-uuid',
      uuid: 'msg-uuid',
      text: 'Hello agent',
    })
    expect(takePendingSessionSeed('sess-1')).toBeUndefined()
  })

  it('includes optional sender', () => {
    seedPendingSessionMessage('sess-1', 'Hi', 'u1', {
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
    })
    expect(takePendingSessionSeed('sess-1')?.sender).toEqual({
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
    })
  })

  it('returns undefined for an unknown session', () => {
    expect(takePendingSessionSeed('missing')).toBeUndefined()
  })
})

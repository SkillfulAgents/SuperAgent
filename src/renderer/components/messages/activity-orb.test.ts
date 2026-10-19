import { describe, it, expect } from 'vitest'
import { deriveIdleStatus } from './activity-orb'

describe('deriveIdleStatus', () => {
  it('invites the first message in a fresh session', () => {
    expect(deriveIdleStatus({ sessionId: 's-1', turnCount: 0, pendingTaskCount: 0 })).toBe('Ready when you are...')
  })

  it('names the steps left in a paused plan', () => {
    expect(deriveIdleStatus({ sessionId: 's-1', turnCount: 2, pendingTaskCount: 1 })).toBe('Paused with 1 task to go...')
    expect(deriveIdleStatus({ sessionId: 's-1', turnCount: 2, pendingTaskCount: 3 })).toBe('Paused with 3 tasks to go...')
  })

  it('holds one line per turn and moves on across turns', () => {
    const line = (turnCount: number) => deriveIdleStatus({ sessionId: 's-1', turnCount, pendingTaskCount: 0 })
    expect(line(4)).toBe(line(4))
    const lines = new Set(Array.from({ length: 12 }, (_, i) => line(i + 1)))
    expect(lines.size).toBeGreaterThan(1)
  })
})

import { describe, expect, it } from 'vitest'
import { formatShortAgo } from './message-time'

describe('formatShortAgo', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0)
  const ago = (ms: number) => formatShortAgo(new Date(now.getTime() - ms), now)
  const MIN = 60_000

  it('abbreviates each unit, rounding down', () => {
    expect(ago(40_000)).toBe('just now')
    expect(ago(5 * MIN + 59_000)).toBe('5m ago')
    expect(ago(16 * 60 * MIN + 20 * MIN)).toBe('16h ago')
    expect(ago(3 * 24 * 60 * MIN)).toBe('3d ago')
    expect(ago(15 * 24 * 60 * MIN)).toBe('2w ago')
  })

  it('counts months and years by the calendar', () => {
    expect(formatShortAgo(new Date(2026, 6, 1), now)).toBe('4mo ago')
    expect(formatShortAgo(new Date(2025, 9, 1), now)).toBe('1y ago')
  })

  it('is empty for an invalid date', () => {
    expect(formatShortAgo(new Date('nope'), now)).toBe('')
  })
})

import { describe, it, expect } from 'vitest'
import { safeDate, formatCompactDistance } from './utils'

describe('safeDate', () => {
  it('handles a numeric epoch (milliseconds)', () => {
    const d = safeDate(1735689600000)
    expect(d.toISOString()).toBe('2025-01-01T00:00:00.000Z')
  })

  it('handles a numeric-string epoch (MCP mappedAt comes as string)', () => {
    const d = safeDate('1735689600000')
    expect(d.toISOString()).toBe('2025-01-01T00:00:00.000Z')
  })

  it('handles an ISO date string (account createdAt)', () => {
    const d = safeDate('2026-04-23T02:25:51.000Z')
    expect(d.toISOString()).toBe('2026-04-23T02:25:51.000Z')
  })

  it('returns an Invalid Date for unparseable input rather than throwing', () => {
    const d = safeDate('not a date')
    expect(d).toBeInstanceOf(Date)
    expect(Number.isNaN(d.getTime())).toBe(true)
  })
})

describe('formatCompactDistance', () => {
  const NOW = new Date('2026-06-09T12:00:00.000Z')
  const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000)
  const daysAgo = (d: number) => secondsAgo(d * 86400)

  it('renders sub-minute ages as "just now"', () => {
    expect(formatCompactDistance(secondsAgo(0), NOW)).toBe('just now')
    expect(formatCompactDistance(secondsAgo(59), NOW)).toBe('just now')
  })

  it('renders minutes, hours, and days compactly', () => {
    expect(formatCompactDistance(secondsAgo(60), NOW)).toBe('1m ago')
    expect(formatCompactDistance(secondsAgo(5 * 60), NOW)).toBe('5m ago')
    expect(formatCompactDistance(secondsAgo(3 * 3600), NOW)).toBe('3h ago')
    expect(formatCompactDistance(daysAgo(2), NOW)).toBe('2d ago')
  })

  it('has no weeks tier — mid-range ages stay in days', () => {
    expect(formatCompactDistance(daysAgo(10), NOW)).toBe('10d ago')
  })

  it('renders months and years', () => {
    expect(formatCompactDistance(daysAgo(61), NOW)).toBe('2mo ago')
    expect(formatCompactDistance(daysAgo(800), NOW)).toBe('2y ago')
  })

  it('renders ~360-day ages as "1y ago", never "0y ago"', () => {
    expect(formatCompactDistance(daysAgo(362), NOW)).toBe('1y ago')
  })

  it('clamps future dates (clock skew) to "just now"', () => {
    expect(formatCompactDistance(secondsAgo(-300), NOW)).toBe('just now')
  })

  it('returns an empty string for invalid dates', () => {
    expect(formatCompactDistance(safeDate('not a date'), NOW)).toBe('')
  })
})

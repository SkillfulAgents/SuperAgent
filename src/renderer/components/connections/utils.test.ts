import { describe, it, expect } from 'vitest'
import { safeDate } from './utils'

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

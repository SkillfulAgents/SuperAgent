import { describe, expect, it } from 'vitest'
import { formatMinutesAgo, formatSince, formatSyncDay, formatUntil, syncCountLabel } from './team-brain-format'

describe('formatting', () => {
  it('reads minutes as people say them', () => {
    expect(formatMinutesAgo(0.4)).toBe('just now')
    expect(formatMinutesAgo(12)).toBe('12 min ago')
    expect(formatMinutesAgo(3 * 60)).toBe('3 h ago')
    expect(formatMinutesAgo(26 * 60)).toBe('yesterday')
    expect(formatMinutesAgo(6 * 24 * 60)).toBe('6 days ago')
  })

  it('handles a missing or bad timestamp', () => {
    expect(formatSince(null)).toBe('never')
    expect(formatSince('garbage')).toBe('never')
    const now = Date.parse('2026-10-21T12:00:00Z')
    expect(formatSince('2026-10-21T11:48:00Z', now)).toBe('12 min ago')
  })

  it('says how long until a time', () => {
    const now = Date.parse('2026-10-21T12:00:00Z')
    expect(formatUntil('2026-10-21T12:47:00Z', now)).toBe('in 47 min')
    expect(formatUntil('2026-10-22T01:00:00Z', now)).toBe('in 13 h')
    expect(formatUntil('2026-10-28T12:00:00Z', now)).toBe('in 7 days')
    expect(formatUntil('2026-10-21T11:00:00Z', now)).toBe('any moment')
  })

  it('names the day a sync ran as people do', () => {
    const now = new Date(2026, 9, 22, 15)
    expect(formatSyncDay(new Date(2026, 9, 22, 9), now)).toBe('Today')
    expect(formatSyncDay(new Date(2026, 9, 21, 23), now)).toBe('Yesterday')
    expect(formatSyncDay(new Date(2026, 9, 19, 9), now)).toMatch(/19/)
    expect(formatSyncDay(new Date(2026, 9, 19, 9), now)).not.toMatch(/2026/)
    expect(formatSyncDay(new Date(2025, 9, 23, 9), now)).toMatch(/2025/)
  })

  it('heads a sync with its counts, or its lines when the counts say nothing', () => {
    expect(syncCountLabel({ added: 3, updated: 9, changes: [] })).toBe('3 pages added, 9 updated')
    expect(syncCountLabel({ added: 0, updated: 1, changes: [] })).toBe('1 page updated')
    expect(syncCountLabel({ added: 0, updated: 0, changes: ['a', 'b'] })).toBe('2 changes')
    expect(syncCountLabel({ added: 0, updated: 0, changes: [] })).toBe('No changes')
  })
})

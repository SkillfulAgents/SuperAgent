import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getFrequencyWarning,
  getNextCronTime,
  parseAtSyntax,
  validateScheduleExpression,
} from './schedule-parser'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-02-10T12:00:00.000Z'))
})

afterEach(() => vi.useRealTimers())

describe('recurring schedules across calendar boundaries', () => {
  it.each([
    {
      name: 'the Sunday morning after Chicago springs forward',
      expression: '0 8 * * 0', timezone: 'America/Chicago', start: '2026-03-08T05:45:00Z',
      expected: ['2026-03-08T13:00:00.000Z', '2026-03-15T13:00:00.000Z'],
    },
    {
      name: 'a missing New York hour moves forward once and returns to the requested hour',
      expression: '30 2 * * *', timezone: 'America/New_York', start: '2026-03-07T12:00:00Z',
      expected: ['2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z'],
    },
    {
      name: 'a repeated New York hour runs once per day',
      expression: '30 1 * * *', timezone: 'America/New_York', start: '2026-10-31T12:00:00Z',
      expected: ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z', '2026-11-03T06:30:00.000Z'],
    },
    {
      name: 'a two-hour Troll gap preserves the transition day',
      expression: '30 1 * * *', timezone: 'Antarctica/Troll', start: '2026-03-28T12:00:00Z',
      expected: ['2026-03-29T01:30:00.000Z', '2026-03-29T23:30:00.000Z', '2026-03-30T23:30:00.000Z'],
    },
    {
      name: 'an existing time immediately after the Lord Howe half-hour gap',
      expression: '30 2 * * *', timezone: 'Australia/Lord_Howe', start: '2026-10-03T05:00:00Z',
      expected: ['2026-10-03T15:30:00.000Z', '2026-10-04T15:30:00.000Z'],
    },
    {
      name: 'leap day skips non-leap years',
      expression: '0 0 29 2 *', timezone: 'UTC', start: '2025-01-01T00:00:00Z',
      expected: ['2028-02-29T00:00:00.000Z', '2032-02-29T00:00:00.000Z'],
    },
    {
      name: 'day 31 skips months that do not contain it',
      expression: '0 9 31 * *', timezone: 'UTC', start: '2026-04-01T00:00:00Z',
      expected: ['2026-05-31T09:00:00.000Z', '2026-07-31T09:00:00.000Z'],
    },
    {
      name: 'a day of month OR an nth weekday preserves both sets of occurrences',
      expression: '0 0 8 * 5#3', timezone: 'UTC', start: '2024-01-01T00:00:00Z',
      expected: ['2024-01-08T00:00:00.000Z', '2024-01-19T00:00:00.000Z', '2024-02-08T00:00:00.000Z'],
    },
    {
      name: 'a matching weekday remains valid when the requested day is absent from February',
      expression: '0 0 31 2 1', timezone: 'UTC', start: '2026-01-01T00:00:00Z',
      expected: ['2026-02-02T00:00:00.000Z', '2026-02-09T00:00:00.000Z'],
    },
  ])('$name', ({ expression, timezone, start, expected }) => {
    vi.setSystemTime(new Date(start))
    for (const timestamp of expected) {
      // The scheduler reparses at each run; a long-lived upstream iterator is
      // not sufficient to prove the application's recurrence behavior.
      const next = getNextCronTime(expression, timezone)
      expect(next.toISOString()).toBe(timestamp)
      expect(next.getTime()).toBeGreaterThan(Date.now())
      vi.setSystemTime(next)
    }
  })

  it('does not flag a daily schedule as frequent across a short DST day', () => {
    vi.setSystemTime(new Date('2026-03-07T00:00:00Z'))
    expect(getFrequencyWarning('cron', '0 8 * * *', 'America/Chicago')).toBeNull()
  })

  it('preserves tab-separated fields when validating and calculating the next run', () => {
    const expression = '\t0\t9\t*\t*\t1-5\t'
    const validated = validateScheduleExpression('cron', expression, 'Asia/Kathmandu')
    expect(validated.valid).toBe(true)
    expect(validated.nextTime?.toISOString()).toBe('2026-02-11T03:15:00.000Z')
    expect(getNextCronTime(expression, 'Asia/Kathmandu')).toEqual(validated.nextTime)
  })

  it.each([
    ['an impossible day/month combination', '0 0 31 4,6 *', /loop limit/i],
    ['duplicate nonzero minute values', '1,1 * * * *', /duplicate/i],
    ['a standalone last-day-of-week marker', '0 0 * * L', /day of week|dayofweek|invalid/i],
    ['an oversized expression', `${'0,'.repeat(600)}0 * * * *`, /too long/i],
  ])('returns a validation error for %s without inventing a next run', (_name, expression, error) => {
    const result = validateScheduleExpression('cron', expression as string, 'UTC')
    expect(result.valid).toBe(false)
    expect(result.nextTime).toBeUndefined()
    expect(result.error).toMatch(error as RegExp)
  })
})

describe('one-time natural-language schedules', () => {
  it.each([
    ['at end of month', '2026-02-28T12:00:00.000Z'],
    ['at end of next month', '2026-03-31T12:00:00.000Z'],
    ['at last day of February 2028', '2028-02-29T12:00:00.000Z'],
    ['at 2027 Jan', '2027-01-01T12:00:00.000Z'],
    ['at tomorrow evening at 6', '2026-02-11T18:00:00.000Z'],
    // These wall-clock times are in the host's DST gap on US/Central European
    // machines, but are valid UTC schedules. Run this suite under those TZs too.
    ['at March 8, 2026 02:30', '2026-03-08T02:30:00.000Z'],
    ['at March 29, 2026 02:30', '2026-03-29T02:30:00.000Z'],
  ])('%s resolves to its intended UTC date', (expression, expected) => {
    const validated = validateScheduleExpression('at', expression, 'UTC')
    expect(validated.valid).toBe(true)
    expect(validated.nextTime?.toISOString()).toBe(expected)
    expect(parseAtSyntax(expression, 'UTC')).toEqual(validated.nextTime)
  })

  it.each(['at 50/6/2027', 'at 99/06/2027', 'at April 31, 2026'])('rejects %s instead of scheduling a date fragment', (expression) => {
    const result = validateScheduleExpression('at', expression, 'UTC')
    expect(result.valid).toBe(false)
    expect(result.nextTime).toBeUndefined()
    expect(result.error).toContain("Invalid 'at' expression")
  })
})

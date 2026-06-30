import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  parseAtSyntax,
  validateAtSyntax,
  getNextCronTime,
  validateCronExpression,
  validateScheduleExpression,
  formatScheduleDescription,
  ianaToOffsetMinutes,
  getMinCronIntervalMs,
  getFrequencyWarning,
  MIN_RECURRING_INTERVAL_MS,
  getScheduleCountWarning,
  SCHEDULE_COUNT_WARN_THRESHOLD,
  SCHEDULE_COUNT_CRITICAL_THRESHOLD,
} from './schedule-parser'

// ============================================================================
// parseAtSyntax Tests
// ============================================================================

describe('parseAtSyntax', () => {
  beforeEach(() => {
    // Mock Date.now() to return a fixed timestamp for predictable tests
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('relative time expressions (at now + N unit)', () => {
    it('parses "at now + 1 second"', () => {
      const result = parseAtSyntax('at now + 1 second')
      expect(result.getTime()).toBe(new Date('2024-06-15T12:00:01.000Z').getTime())
    })

    it('parses "at now + 5 minutes"', () => {
      const result = parseAtSyntax('at now + 5 minutes')
      expect(result.getTime()).toBe(new Date('2024-06-15T12:05:00.000Z').getTime())
    })

    it('parses "at now + 2 hours"', () => {
      const result = parseAtSyntax('at now + 2 hours')
      expect(result.getTime()).toBe(new Date('2024-06-15T14:00:00.000Z').getTime())
    })

    it('parses "at now + 1 day"', () => {
      const result = parseAtSyntax('at now + 1 day')
      expect(result.getTime()).toBe(new Date('2024-06-16T12:00:00.000Z').getTime())
    })

    it('parses "at now + 2 weeks"', () => {
      const result = parseAtSyntax('at now + 2 weeks')
      expect(result.getTime()).toBe(new Date('2024-06-29T12:00:00.000Z').getTime())
    })

    it('parses "at now + 1 month"', () => {
      const result = parseAtSyntax('at now + 1 month')
      expect(result.getTime()).toBe(new Date('2024-07-15T12:00:00.000Z').getTime())
    })

    it('handles singular and plural units', () => {
      const singular = parseAtSyntax('at now + 1 hour')
      const plural = parseAtSyntax('at now + 1 hours')
      expect(singular.getTime()).toBe(plural.getTime())
    })

    it('is case insensitive', () => {
      const lower = parseAtSyntax('at now + 1 hour')
      const upper = parseAtSyntax('AT NOW + 1 HOUR')
      const mixed = parseAtSyntax('At Now + 1 Hour')
      expect(lower.getTime()).toBe(upper.getTime())
      expect(lower.getTime()).toBe(mixed.getTime())
    })
  })

  describe('natural language dates (via chrono-node)', () => {
    it('parses "at tomorrow"', () => {
      const result = parseAtSyntax('at tomorrow')
      // chrono-node interprets "tomorrow" as the next day at noon by default (in UTC)
      expect(result.getUTCDate()).toBe(16)
      expect(result.getUTCMonth()).toBe(5) // June (0-indexed)
    })

    it('parses "at tomorrow 9am"', () => {
      const result = parseAtSyntax('at tomorrow 9am')
      expect(result.getUTCDate()).toBe(16)
      expect(result.getUTCHours()).toBe(9)
    })

    it('parses "at next monday"', () => {
      const result = parseAtSyntax('at next monday')
      // June 15, 2024 is a Saturday, so next Monday is June 17
      expect(result.getUTCDay()).toBe(1) // Monday
    })

    it('throws error for dates in the past', () => {
      expect(() => parseAtSyntax('at yesterday')).toThrow(/in the past/)
    })
  })

  describe('error handling', () => {
    it('throws error for invalid expressions', () => {
      expect(() => parseAtSyntax('invalid')).toThrow(/Invalid/)
      expect(() => parseAtSyntax('at')).toThrow(/Invalid/)
    })

    it('throws error for incomplete relative expressions', () => {
      // "at now + xyz" where xyz is not a valid number+unit should throw
      expect(() => parseAtSyntax('at now + abc')).toThrow()
    })
  })
})

// ============================================================================
// validateAtSyntax Tests
// ============================================================================

describe('validateAtSyntax', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns valid=true with nextTime for valid expressions', () => {
    const result = validateAtSyntax('at now + 1 hour')
    expect(result.valid).toBe(true)
    expect(result.nextTime).toBeDefined()
    expect(result.error).toBeUndefined()
  })

  it('returns valid=false with error for invalid expressions', () => {
    const result = validateAtSyntax('invalid expression')
    expect(result.valid).toBe(false)
    expect(result.nextTime).toBeUndefined()
    expect(result.error).toBeDefined()
  })
})

// ============================================================================
// getNextCronTime Tests
// ============================================================================

describe('getNextCronTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:30:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calculates next time for "every minute" cron', () => {
    const result = getNextCronTime('* * * * *')
    expect(result.getUTCMinutes()).toBe(31) // Next minute after 12:30 UTC
  })

  it('calculates next time for "every hour" cron', () => {
    const result = getNextCronTime('0 * * * *')
    expect(result.getUTCMinutes()).toBe(0)
    expect(result.toISOString()).toBe('2024-06-15T13:00:00.000Z')
  })

  it('calculates next time for "daily at midnight" cron', () => {
    const result = getNextCronTime('0 0 * * *')
    // Next midnight UTC is June 16
    expect(result.toISOString()).toBe('2024-06-16T00:00:00.000Z')
  })

  it('calculates next time for "every 15 minutes" cron', () => {
    const result = getNextCronTime('*/15 * * * *')
    expect(result.getUTCMinutes()).toBe(45) // 12:30 -> 12:45 UTC
  })
})

// ============================================================================
// validateCronExpression Tests
// ============================================================================

describe('validateCronExpression', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns valid=true for valid cron expressions', () => {
    const expressions = [
      '* * * * *',
      '0 * * * *',
      '0 0 * * *',
      '*/15 * * * *',
      '0 9 * * 1-5',
      '0 0 1 * *',
    ]

    for (const expr of expressions) {
      const result = validateCronExpression(expr)
      expect(result.valid).toBe(true)
      expect(result.nextTime).toBeDefined()
    }
  })

  it('returns valid=false for invalid cron expressions', () => {
    const expressions = [
      'invalid',
      'not a cron',
      '* * * * * * *', // Too many fields
    ]

    for (const expr of expressions) {
      const result = validateCronExpression(expr)
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    }
  })
})

// ============================================================================
// getMinCronIntervalMs Tests
// ============================================================================

describe('getMinCronIntervalMs', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('computes a 1-minute interval for every-minute cron', () => {
    expect(getMinCronIntervalMs('* * * * *')).toBe(60_000)
  })

  it('computes a 5-minute interval for */5', () => {
    expect(getMinCronIntervalMs('*/5 * * * *')).toBe(5 * 60_000)
  })

  it('computes a 1-hour interval for hourly cron', () => {
    expect(getMinCronIntervalMs('0 * * * *')).toBe(60 * 60_000)
  })

  it('returns null for an invalid cron expression', () => {
    expect(getMinCronIntervalMs('not a cron')).toBeNull()
  })

  // Bursty schedule: "0,5 * * * *" fires at :00 and :05 each hour. The tightest
  // gap (5 min) must be found regardless of the current time — comparing only the
  // next two occurrences would report ~55 min near the top of the hour.
  it('finds the tightest gap of a bursty schedule independent of current time', () => {
    vi.useFakeTimers()

    vi.setSystemTime(new Date('2024-06-15T00:02:00.000Z')) // next two are :05 then 01:00
    expect(getMinCronIntervalMs('0,5 * * * *')).toBe(5 * 60_000)

    vi.setSystemTime(new Date('2024-06-15T00:58:00.000Z')) // next two are 01:00 then 01:05
    expect(getMinCronIntervalMs('0,5 * * * *')).toBe(5 * 60_000)
  })
})

// ============================================================================
// getFrequencyWarning Tests
// ============================================================================

describe('getFrequencyWarning', () => {
  it('exposes a 15-minute threshold constant', () => {
    expect(MIN_RECURRING_INTERVAL_MS).toBe(15 * 60 * 1000)
  })

  it('warns when the interval is below the threshold', () => {
    const warning = getFrequencyWarning('cron', '*/5 * * * *')
    expect(warning).toBeTruthy()
    expect(warning).toContain('Frequent schedule warning')
    expect(warning).toContain('skipped') // mentions overlap auto-skip
    expect(warning).toContain('cost') // mentions cost
  })

  it('does not warn at exactly the threshold (15 minutes)', () => {
    expect(getFrequencyWarning('cron', '*/15 * * * *')).toBeNull()
  })

  it('does not warn above the threshold', () => {
    expect(getFrequencyWarning('cron', '0 9 * * 1-5')).toBeNull()
  })

  it('never warns for one-time (at) schedules', () => {
    expect(getFrequencyWarning('at', 'at now + 1 minute')).toBeNull()
  })

  it('does not warn for an unparseable cron expression', () => {
    expect(getFrequencyWarning('cron', 'not a cron')).toBeNull()
  })

  it('warns for a bursty schedule whose tightest gap is below the threshold', () => {
    // ":00 and :05 every hour" — the 5-minute burst gap is under 15 min.
    expect(getFrequencyWarning('cron', '0,5 * * * *')).toContain('Frequent schedule warning')
  })
})

// ============================================================================
// getScheduleCountWarning Tests
// ============================================================================

describe('getScheduleCountWarning', () => {
  it('exposes conservative warn/critical threshold constants', () => {
    expect(SCHEDULE_COUNT_WARN_THRESHOLD).toBe(4)
    expect(SCHEDULE_COUNT_CRITICAL_THRESHOLD).toBe(6)
  })

  it('does not warn at or below the warn threshold', () => {
    expect(getScheduleCountWarning(0)).toBeNull()
    expect(getScheduleCountWarning(1)).toBeNull()
    expect(getScheduleCountWarning(SCHEDULE_COUNT_WARN_THRESHOLD)).toBeNull() // exactly 4
  })

  it('warns just above the warn threshold (but not critical)', () => {
    const warning = getScheduleCountWarning(5)
    expect(warning).toBeTruthy()
    expect(warning).toContain('Schedule count warning')
    expect(warning).toContain('5 active schedules')
    expect(warning).not.toContain('CRITICAL')
  })

  it('still only warns (not critical) at the critical threshold itself', () => {
    const warning = getScheduleCountWarning(SCHEDULE_COUNT_CRITICAL_THRESHOLD) // exactly 6
    expect(warning).toContain('Schedule count warning')
    expect(warning).not.toContain('CRITICAL')
  })

  it('escalates to a critical warning above the critical threshold', () => {
    const warning = getScheduleCountWarning(7)
    expect(warning).toBeTruthy()
    expect(warning).toContain('CRITICAL')
    expect(warning).toContain('7 active schedules')
    // The critical band mentions the runaway / self-replicating failure mode.
    expect(warning).toContain('self-replicating')
  })
})

// ============================================================================
// validateScheduleExpression Tests
// ============================================================================

describe('validateScheduleExpression', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('validates "at" type expressions', () => {
    const valid = validateScheduleExpression('at', 'at now + 1 hour')
    expect(valid.valid).toBe(true)

    const invalid = validateScheduleExpression('at', 'invalid')
    expect(invalid.valid).toBe(false)
  })

  it('validates "cron" type expressions', () => {
    const valid = validateScheduleExpression('cron', '*/15 * * * *')
    expect(valid.valid).toBe(true)

    const invalid = validateScheduleExpression('cron', 'invalid')
    expect(invalid.valid).toBe(false)
  })
})

// ============================================================================
// formatScheduleDescription Tests
// ============================================================================

describe('formatScheduleDescription', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('formats "at" expressions as one-time with date', () => {
    const result = formatScheduleDescription('at', 'at now + 1 hour')
    expect(result).toContain('One-time')
  })

  it('formats "cron" expressions as recurring', () => {
    const result = formatScheduleDescription('cron', '*/15 * * * *')
    expect(result).toBe('Recurring: */15 * * * *')
  })

  it('handles invalid "at" expressions gracefully', () => {
    const result = formatScheduleDescription('at', 'invalid')
    expect(result).toBe('One-time: invalid')
  })
})

// ============================================================================
// ianaToOffsetMinutes Tests
// ============================================================================

describe('ianaToOffsetMinutes', () => {
  it('returns 0 for UTC', () => {
    expect(ianaToOffsetMinutes('UTC')).toBe(0)
  })

  it('returns correct offset for fixed-offset timezones', () => {
    // Etc/GMT+5 is UTC-5 (POSIX convention is inverted)
    const offset = ianaToOffsetMinutes('Etc/GMT+5')
    expect(offset).toBe(-300)
  })

  it('returns a non-zero offset for a non-UTC timezone', () => {
    // Asia/Tokyo is always UTC+9 (no DST)
    const offset = ianaToOffsetMinutes('Asia/Tokyo')
    expect(offset).toBe(540)
  })

  it('respects DST based on reference date', () => {
    // America/New_York: EST (UTC-5) in winter, EDT (UTC-4) in summer
    const winter = new Date('2024-01-15T12:00:00Z')
    const summer = new Date('2024-07-15T12:00:00Z')
    const winterOffset = ianaToOffsetMinutes('America/New_York', winter)
    const summerOffset = ianaToOffsetMinutes('America/New_York', summer)
    expect(winterOffset).toBe(-300) // EST = UTC-5
    expect(summerOffset).toBe(-240) // EDT = UTC-4
  })
})

// ============================================================================
// Timezone-aware parseAtSyntax Tests
// ============================================================================

describe('parseAtSyntax with timezone', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('relative times are timezone-independent', () => {
    // "at now + 1 hour" should be the same regardless of timezone
    const withoutTz = parseAtSyntax('at now + 1 hour')
    const withTokyo = parseAtSyntax('at now + 1 hour', 'Asia/Tokyo')
    const withNY = parseAtSyntax('at now + 1 hour', 'America/New_York')
    expect(withoutTz.getTime()).toBe(withTokyo.getTime())
    expect(withoutTz.getTime()).toBe(withNY.getTime())
  })

  it('natural language "tomorrow 9am" differs by timezone', () => {
    // "tomorrow 9am" in Tokyo vs New York should produce different UTC times
    const tokyo = parseAtSyntax('at tomorrow 9am', 'Asia/Tokyo')
    const ny = parseAtSyntax('at tomorrow 9am', 'America/New_York')
    // Tokyo is UTC+9, NY is UTC-4 (EDT in June), difference is 13 hours
    const diffHours = (ny.getTime() - tokyo.getTime()) / 3600000
    expect(diffHours).toBe(13)
  })
})

// ============================================================================
// Timezone-aware getNextCronTime Tests
// ============================================================================

describe('getNextCronTime with timezone', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Set to June 15, 2024 at 20:00 UTC
    vi.setSystemTime(new Date('2024-06-15T20:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('respects timezone for daily cron', () => {
    // "0 9 * * *" = daily at 9am
    // In UTC: next 9am UTC is June 16 at 09:00 UTC
    const utcResult = getNextCronTime('0 9 * * *', 'UTC')
    expect(utcResult.toISOString()).toBe('2024-06-16T09:00:00.000Z')

    // In Asia/Tokyo (UTC+9): current time is 20:00 UTC = 05:00 June 16 Tokyo time
    // So next 9am Tokyo is June 16 at 9am Tokyo = June 16 00:00 UTC
    const tokyoResult = getNextCronTime('0 9 * * *', 'Asia/Tokyo')
    expect(tokyoResult.toISOString()).toBe('2024-06-16T00:00:00.000Z')
  })

  it('produces same result when timezone is undefined vs omitted', () => {
    const withoutTz = getNextCronTime('*/15 * * * *')
    const withUndefined = getNextCronTime('*/15 * * * *', undefined)
    expect(withoutTz.getTime()).toBe(withUndefined.getTime())
  })

  it('different timezones produce different next execution times for fixed-hour crons', () => {
    // "0 2 * * *" = daily at 2am
    const tokyo = getNextCronTime('0 2 * * *', 'Asia/Tokyo')
    const ny = getNextCronTime('0 2 * * *', 'America/New_York')
    // These should differ because 2am Tokyo != 2am New York in UTC
    expect(tokyo.getTime()).not.toBe(ny.getTime())
  })
})

// ============================================================================
// validateScheduleExpression with timezone Tests
// ============================================================================

describe('validateScheduleExpression with timezone', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('validates "at" expressions with timezone', () => {
    const result = validateScheduleExpression('at', 'at now + 1 hour', 'America/New_York')
    expect(result.valid).toBe(true)
    expect(result.nextTime).toBeDefined()
  })

  it('validates "cron" expressions with timezone', () => {
    const result = validateScheduleExpression('cron', '0 9 * * *', 'Asia/Tokyo')
    expect(result.valid).toBe(true)
    expect(result.nextTime).toBeDefined()
  })

  it('rejects invalid cron even with valid timezone', () => {
    const result = validateScheduleExpression('cron', 'invalid', 'Asia/Tokyo')
    expect(result.valid).toBe(false)
  })
})

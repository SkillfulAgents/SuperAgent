import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  parseAtSyntax,
  validateAtSyntax,
  getNextCronTime,
  validateCronExpression,
  validateScheduleExpression,
  formatScheduleDescription,
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
      // chrono-node interprets "tomorrow" as the next day at noon by default
      expect(result.getDate()).toBe(16)
      expect(result.getMonth()).toBe(5) // June (0-indexed)
    })

    it('parses "at tomorrow 9am"', () => {
      const result = parseAtSyntax('at tomorrow 9am')
      expect(result.getDate()).toBe(16)
      expect(result.getHours()).toBe(9)
    })

    it('parses "at next monday"', () => {
      const result = parseAtSyntax('at next monday')
      // June 15, 2024 is a Saturday, so next Monday is June 17
      expect(result.getDay()).toBe(1) // Monday
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
    expect(result.getMinutes()).toBe(31) // Next minute after 12:30
  })

  it('calculates next time for "every hour" cron', () => {
    const result = getNextCronTime('0 * * * *')
    expect(result.getMinutes()).toBe(0)
    // Next hour at :00 - could be 13 UTC or local time depending on timezone
    expect(result.getTime()).toBeGreaterThan(new Date('2024-06-15T12:30:00.000Z').getTime())
  })

  it('calculates next time for "daily at midnight" cron', () => {
    const result = getNextCronTime('0 0 * * *')
    // Should be sometime after now (next midnight)
    expect(result.getTime()).toBeGreaterThan(new Date('2024-06-15T12:30:00.000Z').getTime())
    expect(result.getMinutes()).toBe(0)
    expect(result.getHours()).toBe(0)
  })

  it('calculates next time for "every 15 minutes" cron', () => {
    const result = getNextCronTime('*/15 * * * *')
    expect(result.getMinutes()).toBe(45) // 12:30 -> 12:45
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

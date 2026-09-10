import { describe, it, expect } from 'vitest'
import { promptDate } from './prompt-date'

describe('promptDate', () => {
  // 23:30Z sits on both sides of midnight depending on the zone.
  const instant = new Date('2026-09-10T23:30:00Z')

  it.each([
    ['UTC', { date: '2026-09-10', weekday: 'Thursday', utcOffset: 'UTC+00:00' }],
    ['Asia/Kolkata', { date: '2026-09-11', weekday: 'Friday', utcOffset: 'UTC+05:30' }],
  ])('renders the calendar day and offset in %s', (timeZone, expected) => {
    expect(promptDate(instant, timeZone)).toEqual({ timeZone, ...expected })
  })
})

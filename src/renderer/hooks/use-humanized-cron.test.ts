import { describe, expect, it } from 'vitest'
import { CronExpressionParser } from 'cron-parser'
import { humanizeCron } from './use-humanized-cron'

describe('humanizeCron', () => {
  it.each([
    ['0 9 * * 1-5', 'At 09:00 AM, Monday through Friday'],
    ['*/15 * * * *', 'Every 15 minutes, every hour, every day'],
    ['0 0 */5 * *', 'At 12:00 AM, every 5 days in a month'],
  ])('describes %s using the app’s verbose, twelve-hour format', (expression, expected) => {
    expect(humanizeCron(expression)).toBe(expected)
  })

  it('spells out uneven minute steps instead of implying a fixed interval across hours', () => {
    expect(humanizeCron('*/7 * * * *')).toBe(
      'Every 7 minutes, at 0, 7, 14, 21, 28, 35, 42, 49, and 56 minutes past the hour, every hour, every day',
    )
    // The shorter gap at the hour boundary is why listing the actual values
    // matters: this schedule does not run at a continuous seven-minute interval.
    const schedule = CronExpressionParser.parse('*/7 * * * *', {
      currentDate: '2026-10-23T12:55:00Z', tz: 'UTC',
    })
    expect(schedule.next().toISOString()).toBe('2026-10-23T12:56:00.000Z')
    expect(schedule.next().toISOString()).toBe('2026-10-23T13:00:00.000Z')
  })

  it('spells out uneven hour steps including the reset at midnight', () => {
    expect(humanizeCron('0 */5 * * *')).toBe(
      'On the hour, every 5 hours, at 12:00 AM, 05:00 AM, 10:00 AM, 03:00 PM, and 08:00 PM, every day',
    )
    const schedule = CronExpressionParser.parse('0 */5 * * *', {
      currentDate: '2026-10-23T19:59:00Z', tz: 'UTC',
    })
    expect(schedule.next().toISOString()).toBe('2026-10-23T20:00:00.000Z')
    expect(schedule.next().toISOString()).toBe('2026-10-24T00:00:00.000Z')
  })

  it.each(['not a cron', '0 25 * * *', '0 9 * 13 *'])(
    'keeps the raw expression visible when the description rejects %s',
    (expression) => {
      expect(humanizeCron(expression)).toBe(expression)
    },
  )
})

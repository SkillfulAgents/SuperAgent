import { describe, expect, it } from 'vitest'
import {
  activityDayKey,
  buildCronActivitySeries,
  buildDailyActivitySeries,
  CRON_SLOT_GRACE_MS,
  getActivityWindowStart,
  normalizeAutomationStatus,
} from './activity-aggregation'

const NOW = new Date('2026-07-09T12:00:30.000Z')

describe('activity aggregation', () => {
  describe('automation status narrowing', () => {
    it.each([
      ['running', 'running'],
      ['succeeded', 'succeeded'],
      ['failed', 'failed'],
      // Lenient metadata schema: a newer build's unknown status narrows to
      // undefined instead of corrupting rank comparisons.
      ['cancelled', undefined],
      ['', undefined],
      [42, undefined],
      [null, undefined],
      [undefined, undefined],
    ])('narrows %o to %o', (value, expected) => {
      expect(normalizeAutomationStatus(value)).toBe(expected)
    })
  })

  describe('day bucketing', () => {
    it('buckets by the viewer\'s clock via the tz offset', () => {
      const instant = new Date('2026-07-09T02:00:00.000Z')
      expect(activityDayKey(instant)).toBe('2026-07-09')
      // UTC-5 viewer (offset +300): 02:00Z is still the previous local day.
      expect(activityDayKey(instant, 300)).toBe('2026-07-08')
      // UTC+9 viewer (offset -540): 20:00Z is already the next local day.
      expect(activityDayKey(new Date('2026-07-09T20:00:00.000Z'), -540)).toBe('2026-07-10')
    })

    it('starts the window at the UTC instant the oldest local day began', () => {
      expect(getActivityWindowStart(3, NOW).toISOString()).toBe('2026-07-07T00:00:00.000Z')
      // UTC-5 viewer: local July 7 starts at 05:00Z.
      expect(getActivityWindowStart(3, NOW, 300).toISOString()).toBe('2026-07-07T05:00:00.000Z')
    })
  })

  describe('daily series', () => {
    it('zero-fills every day and preserves chronological order', () => {
      expect(buildDailyActivitySeries([], { days: 3, now: NOW })).toEqual([
        { date: '2026-07-07', succeeded: 0, failed: 0 },
        { date: '2026-07-08', succeeded: 0, failed: 0 },
        { date: '2026-07-09', succeeded: 0, failed: 0 },
      ])
    })

    it('sums pre-bucketed volume by day and outcome', () => {
      const series = buildDailyActivitySeries([
        { day: '2026-07-08', outcome: 'succeeded', count: 3 },
        { day: '2026-07-08', outcome: 'failed', count: 2 },
        { day: '2026-07-09', outcome: 'succeeded' },
      ], { days: 2, now: NOW })

      expect(series).toEqual([
        { date: '2026-07-08', succeeded: 3, failed: 2 },
        { date: '2026-07-09', succeeded: 1, failed: 0 },
      ])
    })

    it('labels buckets with local days when a tz offset is given', () => {
      // UTC-5 viewer at 12:00:30Z on July 9 → local today is July 9; an
      // event bucketed to local July 8 lands in yesterday's bar.
      const series = buildDailyActivitySeries([
        { day: activityDayKey(new Date('2026-07-09T02:00:00.000Z'), 300), outcome: 'succeeded' },
      ], { days: 2, now: NOW, tzOffsetMinutes: 300 })

      expect(series).toEqual([
        { date: '2026-07-08', succeeded: 1, failed: 0 },
        { date: '2026-07-09', succeeded: 0, failed: 0 },
      ])
    })

    it('ignores malformed, future, and out-of-window events without corrupting buckets', () => {
      const series = buildDailyActivitySeries([
        { day: 'not-a-day', outcome: 'succeeded' },
        { day: '2026-07-06', outcome: 'succeeded', count: 100 },
        { day: '2026-07-10', outcome: 'failed', count: 100 },
        { day: '2026-07-09', outcome: 'succeeded', count: -4 },
      ], { days: 3, now: NOW })

      expect(series).toEqual([
        { date: '2026-07-07', succeeded: 0, failed: 0 },
        { date: '2026-07-08', succeeded: 0, failed: 0 },
        { date: '2026-07-09', succeeded: 1, failed: 0 },
      ])
    })
  })

  describe('cron series', () => {
    const hourlyTask = {
      id: 'cron-hourly',
      scheduleExpression: '0 * * * *',
      timezone: 'UTC',
      createdAt: new Date('2026-07-09T06:30:00.000Z'),
      pausedAt: null,
      cancelledAt: null,
    }

    it('matches executions to their exact planned slot and marks mature gaps skipped', () => {
      const result = buildCronActivitySeries({
        task: hourlyTask,
        sessions: [
          { scheduledExecutionAt: '2026-07-09T09:00:00.000Z' },
          { scheduledExecutionAt: '2026-07-09T11:00:00.000Z' },
        ],
        now: NOW,
        slots: 5,
      })

      expect(result).toEqual([
        { scheduledAt: '2026-07-09T07:00:00.000Z', status: 'skipped' },
        { scheduledAt: '2026-07-09T08:00:00.000Z', status: 'skipped' },
        { scheduledAt: '2026-07-09T09:00:00.000Z', status: 'succeeded' },
        { scheduledAt: '2026-07-09T10:00:00.000Z', status: 'skipped' },
        { scheduledAt: '2026-07-09T11:00:00.000Z', status: 'succeeded' },
      ])
    })

    it('marks an in-flight slot running and lets it override a stale duplicate success', () => {
      const result = buildCronActivitySeries({
        task: hourlyTask,
        sessions: [
          { scheduledExecutionAt: '2026-07-09T10:00:00.000Z' },
          {
            scheduledExecutionAt: '2026-07-09T10:00:00.000Z',
            automationStatus: 'running',
          },
          {
            scheduledExecutionAt: '2026-07-09T11:00:00.000Z',
            automationStatus: 'running',
          },
        ],
        now: NOW,
        slots: 2,
      })

      expect(result).toEqual([
        { scheduledAt: '2026-07-09T10:00:00.000Z', status: 'running' },
        { scheduledAt: '2026-07-09T11:00:00.000Z', status: 'running' },
      ])
    })

    it('uses session outcome metadata and lets a failure override a duplicate legacy match', () => {
      const result = buildCronActivitySeries({
        task: hourlyTask,
        sessions: [
          { scheduledExecutionAt: '2026-07-09T10:00:00.000Z' },
          {
            scheduledExecutionAt: '2026-07-09T10:00:00.000Z',
            automationStatus: 'failed',
          },
        ],
        now: NOW,
        slots: 2,
      })

      expect(result).toEqual([
        { scheduledAt: '2026-07-09T10:00:00.000Z', status: 'failed' },
        { scheduledAt: '2026-07-09T11:00:00.000Z', status: 'skipped' },
      ])
    })

    it('does not label a slot skipped while it is still inside the scheduler grace period', () => {
      const result = buildCronActivitySeries({
        task: {
          ...hourlyTask,
          scheduleExpression: '* * * * *',
          createdAt: new Date('2026-07-09T11:55:00.000Z'),
        },
        sessions: [],
        now: NOW,
        slots: 10,
      })

      expect(result.at(-1)?.scheduledAt).toBe('2026-07-09T11:59:00.000Z')
      expect(new Date(result.at(-1)!.scheduledAt).getTime()).toBeLessThanOrEqual(
        NOW.getTime() - CRON_SLOT_GRACE_MS,
      )
    })

    it('never invents slots before creation or after pause/cancellation', () => {
      const result = buildCronActivitySeries({
        task: {
          ...hourlyTask,
          createdAt: new Date('2026-07-09T08:30:00.000Z'),
          pausedAt: new Date('2026-07-09T10:20:00.000Z'),
        },
        sessions: [],
        now: NOW,
        slots: 10,
      })

      expect(result.map((point) => point.scheduledAt)).toEqual([
        '2026-07-09T09:00:00.000Z',
        '2026-07-09T10:00:00.000Z',
      ])
    })

    it('honors IANA timezones across DST boundaries', () => {
      const result = buildCronActivitySeries({
        task: {
          ...hourlyTask,
          scheduleExpression: '30 1 * * *',
          timezone: 'America/Los_Angeles',
          createdAt: new Date('2026-10-30T00:00:00.000Z'),
        },
        sessions: [],
        now: new Date('2026-11-03T20:00:00.000Z'),
        slots: 4,
      })

      expect(result.map((point) => point.scheduledAt)).toEqual([
        '2026-11-01T08:30:00.000Z',
        '2026-11-01T09:30:00.000Z',
        '2026-11-02T09:30:00.000Z',
        '2026-11-03T09:30:00.000Z',
      ])
    })

    it('deduplicates repeated session metadata and excludes manual runs without a planned time', () => {
      const result = buildCronActivitySeries({
        task: hourlyTask,
        sessions: [
          { scheduledExecutionAt: '2026-07-09T11:00:00.000Z' },
          { scheduledExecutionAt: '2026-07-09T11:00:00.000Z' },
          { scheduledExecutionAt: undefined },
        ],
        now: NOW,
        slots: 1,
      })

      expect(result).toEqual([
        { scheduledAt: '2026-07-09T11:00:00.000Z', status: 'succeeded' },
      ])
    })

    it('fails closed to an empty chart for invalid expressions', () => {
      expect(buildCronActivitySeries({
        task: { ...hourlyTask, scheduleExpression: 'not cron' },
        sessions: [],
        now: NOW,
        slots: 5,
      })).toEqual([])
    })
  })
})

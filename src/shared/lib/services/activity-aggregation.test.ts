import { describe, expect, it } from 'vitest'
import {
  buildCronActivitySeries,
  buildDailyActivitySeries,
  classifyRequestOutcome,
  CRON_SLOT_GRACE_MS,
} from './activity-aggregation'

const NOW = new Date('2026-07-09T12:00:30.000Z')

describe('activity aggregation', () => {
  describe('request outcomes', () => {
    it.each([
      [{ statusCode: 200, errorMessage: null, policyDecision: 'allow' }, 'succeeded'],
      [{ statusCode: 302, errorMessage: null, policyDecision: 'allow' }, 'succeeded'],
      [{ statusCode: 400, errorMessage: null, policyDecision: 'allow' }, 'failed'],
      [{ statusCode: null, errorMessage: 'network timeout', policyDecision: 'allow' }, 'failed'],
      [{ statusCode: 200, errorMessage: 'tool returned an error', policyDecision: 'allow' }, 'failed'],
      [{ statusCode: 200, errorMessage: null, policyDecision: 'block' }, 'failed'],
      [{ statusCode: 200, errorMessage: null, policyDecision: 'denied_by_user' }, 'failed'],
      [{ statusCode: 200, errorMessage: null, policyDecision: 'review_timeout' }, 'failed'],
    ] as const)('classifies %o as %s', (event, expected) => {
      expect(classifyRequestOutcome(event)).toBe(expected)
    })
  })

  describe('daily series', () => {
    it('zero-fills every UTC day and preserves chronological order', () => {
      expect(buildDailyActivitySeries([], { days: 3, now: NOW })).toEqual([
        { date: '2026-07-07', succeeded: 0, failed: 0 },
        { date: '2026-07-08', succeeded: 0, failed: 0 },
        { date: '2026-07-09', succeeded: 0, failed: 0 },
      ])
    })

    it('sums invocation volume by UTC day and outcome', () => {
      const series = buildDailyActivitySeries([
        { createdAt: new Date('2026-07-08T00:00:00.000Z'), outcome: 'succeeded', count: 3 },
        { createdAt: new Date('2026-07-08T23:59:59.999Z'), outcome: 'failed', count: 2 },
        { createdAt: new Date('2026-07-09T00:00:00.000Z'), outcome: 'succeeded' },
      ], { days: 2, now: NOW })

      expect(series).toEqual([
        { date: '2026-07-08', succeeded: 3, failed: 2 },
        { date: '2026-07-09', succeeded: 1, failed: 0 },
      ])
    })

    it('ignores malformed, future, and out-of-window events without corrupting buckets', () => {
      const series = buildDailyActivitySeries([
        { createdAt: new Date('invalid'), outcome: 'succeeded' },
        { createdAt: new Date('2026-07-06T23:59:59.999Z'), outcome: 'succeeded', count: 100 },
        { createdAt: new Date('2026-07-10T00:00:00.000Z'), outcome: 'failed', count: 100 },
        { createdAt: new Date('2026-07-09T08:00:00.000Z'), outcome: 'succeeded', count: -4 },
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

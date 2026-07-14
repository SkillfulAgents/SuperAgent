import { CronExpressionParser } from 'cron-parser'
import type {
  ActivityOutcome,
  CronActivityPoint,
  DailyActivityPoint,
} from '@shared/lib/types/activity'

export const CRON_SLOT_GRACE_MS = 60_000

// Policy decisions that mean the request never reached (or was rejected by)
// the upstream service. Shared with the SQL outcome classifier in
// activity-stats-service — keep the two in sync.
export const FAILURE_POLICY_DECISIONS = [
  'block',
  'denied_by_user',
  'review_timeout',
] as const

const AUTOMATION_STATUSES = new Set(['running', 'succeeded', 'failed'])

export type AutomationStatus = 'running' | 'succeeded' | 'failed'

/**
 * The metadata schema is deliberately lenient (bare string), so a file written
 * by a newer build can carry a status this reader doesn't know. Unknown values
 * narrow to undefined, which downstream treats like a legacy pre-tracking
 * session rather than corrupting rank comparisons.
 */
export function normalizeAutomationStatus(value: unknown): AutomationStatus | undefined {
  return typeof value === 'string' && AUTOMATION_STATUSES.has(value)
    ? (value as AutomationStatus)
    : undefined
}

export interface DailyActivityEvent {
  /** Calendar-day bucket key (YYYY-MM-DD) in the requested display timezone. */
  day: string
  outcome: ActivityOutcome
  count?: number
}

export interface DailySeriesOptions {
  days: number
  now?: Date
  /**
   * Minutes to subtract from UTC to reach the viewer's local clock, as
   * reported by `Date.prototype.getTimezoneOffset()`. A fixed offset is a
   * deliberate approximation: events within an hour of a DST transition can
   * land one bucket off, which is acceptable for daily spark bars.
   */
  tzOffsetMinutes?: number
}

/** Bucket an instant into a calendar day for the given fixed UTC offset. */
export function activityDayKey(date: Date, tzOffsetMinutes = 0): string {
  return new Date(date.getTime() - tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

/** UTC instant when the oldest local calendar day of the window began. */
export function getActivityWindowStart(
  days: number,
  now: Date = new Date(),
  tzOffsetMinutes = 0,
): Date {
  const localToday = new Date(`${activityDayKey(now, tzOffsetMinutes)}T00:00:00.000Z`)
  localToday.setUTCDate(localToday.getUTCDate() - Math.max(0, Math.floor(days) - 1))
  return new Date(localToday.getTime() + tzOffsetMinutes * 60_000)
}

export function buildDailyActivitySeries(
  events: DailyActivityEvent[],
  options: DailySeriesOptions,
): DailyActivityPoint[] {
  const days = Math.max(1, Math.floor(options.days))
  const now = options.now ?? new Date()
  const tzOffsetMinutes = options.tzOffsetMinutes ?? 0
  const todayKey = activityDayKey(now, tzOffsetMinutes)
  const buckets = new Map<string, DailyActivityPoint>()

  const day = new Date(`${todayKey}T00:00:00.000Z`)
  day.setUTCDate(day.getUTCDate() - (days - 1))
  for (let offset = 0; offset < days; offset += 1) {
    const key = day.toISOString().slice(0, 10)
    buckets.set(key, { date: key, succeeded: 0, failed: 0 })
    day.setUTCDate(day.getUTCDate() + 1)
  }

  for (const event of events) {
    if (event.day > todayKey) continue
    const bucket = buckets.get(event.day)
    if (!bucket) continue
    const count = Number.isInteger(event.count) && event.count! > 0 ? event.count! : 1
    bucket[event.outcome] += count
  }

  return [...buckets.values()]
}

interface CronTaskInput {
  id: string
  scheduleExpression: string
  timezone?: string | null
  createdAt: Date
  pausedAt?: Date | null
  cancelledAt?: Date | null
}

interface CronSessionInput {
  scheduledExecutionAt?: string
  automationStatus?: AutomationStatus
}

export interface CronActivityInput {
  task: CronTaskInput
  sessions: CronSessionInput[]
  now?: Date
  slots: number
}

function earliestDate(...dates: Array<Date | null | undefined>): Date {
  return new Date(Math.min(...dates.filter((date): date is Date => !!date).map((date) => date.getTime())))
}

export function buildCronActivitySeries(input: CronActivityInput): CronActivityPoint[] {
  const now = input.now ?? new Date()
  const matureThrough = new Date(now.getTime() - CRON_SLOT_GRACE_MS)
  const end = earliestDate(matureThrough, input.task.pausedAt, input.task.cancelledAt)
  const limit = Math.max(0, Math.floor(input.slots))
  if (limit === 0 || !Number.isFinite(end.getTime())) return []

  const planned: Date[] = []
  try {
    const expression = CronExpressionParser.parse(input.task.scheduleExpression, {
      tz: input.task.timezone || 'UTC',
      currentDate: end,
    })
    for (let index = 0; index < limit; index += 1) {
      const previous = expression.prev().toDate()
      if (previous.getTime() < input.task.createdAt.getTime()) break
      planned.push(previous)
    }
  } catch {
    return []
  }

  // Sessions are matched to planned slots by exact ISO-string equality:
  // the scheduler records `scheduledExecutionAt` as `nextExecutionAt.toISOString()`,
  // which both come from cron-parser over the task's current expression/timezone.
  // Editing a task's schedule or timezone breaks that invariant for older runs —
  // they no longer match any reconstructed slot and render as skipped.
  // Legacy sessions without an automationStatus predate outcome tracking and are
  // assumed to have succeeded. A failure wins over duplicate metadata for the
  // same planned slot, and a live rerun ('running') wins over a stale success.
  const OUTCOME_RANK = { failed: 3, running: 2, succeeded: 1 } as const
  const outcomeBySlot = new Map<string, keyof typeof OUTCOME_RANK>()
  for (const session of input.sessions) {
    if (!session.scheduledExecutionAt) continue
    const outcome = session.automationStatus ?? 'succeeded'
    const existing = outcomeBySlot.get(session.scheduledExecutionAt)
    if (!existing || OUTCOME_RANK[outcome] > OUTCOME_RANK[existing]) {
      outcomeBySlot.set(session.scheduledExecutionAt, outcome)
    }
  }

  return planned.reverse().map((scheduledAt) => {
    const key = scheduledAt.toISOString()
    const status = outcomeBySlot.get(key) ?? 'skipped'
    return { scheduledAt: key, status }
  })
}

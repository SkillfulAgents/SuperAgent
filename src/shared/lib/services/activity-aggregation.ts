import { CronExpressionParser } from 'cron-parser'
import type {
  ActivityOutcome,
  CronActivityPoint,
  DailyActivityPoint,
} from '@shared/lib/types/activity'

export const CRON_SLOT_GRACE_MS = 60_000

const FAILURE_POLICY_DECISIONS = new Set([
  'block',
  'denied_by_user',
  'review_timeout',
])

export interface RequestOutcomeInput {
  statusCode: number | null
  errorMessage?: string | null
  policyDecision?: string | null
}

export function classifyRequestOutcome(input: RequestOutcomeInput): ActivityOutcome {
  if (input.errorMessage) return 'failed'
  if (input.policyDecision && FAILURE_POLICY_DECISIONS.has(input.policyDecision)) return 'failed'
  if (input.statusCode === null || !Number.isFinite(input.statusCode)) return 'failed'
  return input.statusCode >= 200 && input.statusCode < 400 ? 'succeeded' : 'failed'
}

export interface DailyActivityEvent {
  createdAt: Date
  outcome: ActivityOutcome
  count?: number
}

export interface DailySeriesOptions {
  days: number
  now?: Date
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function getActivityWindowStart(days: number, now: Date = new Date()): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  start.setUTCDate(start.getUTCDate() - Math.max(0, Math.floor(days) - 1))
  return start
}

export function buildDailyActivitySeries(
  events: DailyActivityEvent[],
  options: DailySeriesOptions,
): DailyActivityPoint[] {
  const days = Math.max(1, Math.floor(options.days))
  const now = options.now ?? new Date()
  const start = getActivityWindowStart(days, now)
  const buckets = new Map<string, DailyActivityPoint>()

  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(start)
    date.setUTCDate(date.getUTCDate() + offset)
    const key = utcDay(date)
    buckets.set(key, { date: key, succeeded: 0, failed: 0 })
  }

  for (const event of events) {
    const time = event.createdAt.getTime()
    if (!Number.isFinite(time) || time > now.getTime()) continue
    const bucket = buckets.get(utcDay(event.createdAt))
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
  automationStatus?: 'running' | 'succeeded' | 'failed'
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

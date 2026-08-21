/**
 * Schedule Parser Utility
 *
 * Parses and validates schedule expressions for the scheduled task system.
 * Supports both "at" syntax for one-time tasks and cron syntax for recurring tasks.
 */

import { CronExpressionParser } from 'cron-parser'
import * as chrono from 'chrono-node'

export interface ParseResult {
  valid: boolean
  nextTime?: Date
  error?: string
}

/**
 * Convert an IANA timezone name to a UTC offset in minutes for chrono-node.
 * chrono-node does not support IANA names natively — only abbreviations and numeric offsets.
 */
export function ianaToOffsetMinutes(timezone: string, refDate?: Date): number {
  const date = refDate ?? new Date()
  // Get the UTC time string in the target timezone
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' })
  const tzStr = date.toLocaleString('en-US', { timeZone: timezone })
  const utcDate = new Date(utcStr)
  const tzDate = new Date(tzStr)
  return Math.round((tzDate.getTime() - utcDate.getTime()) / 60000)
}

/**
 * Parse "at" syntax for one-time scheduled tasks.
 *
 * Supported formats:
 * - "at now + N unit" (e.g., "at now + 1 hour", "at now + 2 days")
 * - "at tomorrow 9am"
 * - "at next monday"
 * - "at 2024-03-15 14:00"
 * - Natural language dates via chrono-node
 */
export function parseAtSyntax(expression: string, timezone?: string): Date {
  // Normalize the expression
  const normalized = expression.trim().toLowerCase()

  // Handle "at now + N unit" format — timezone-independent (relative to now)
  const nowPlusMatch = normalized.match(
    /^at\s+now\s*\+\s*(\d+)\s*(second|minute|hour|day|week|month)s?$/i
  )
  if (nowPlusMatch) {
    const amount = parseInt(nowPlusMatch[1], 10)
    const unit = nowPlusMatch[2].toLowerCase()
    const now = new Date()

    switch (unit) {
      case 'second':
        return new Date(now.getTime() + amount * 1000)
      case 'minute':
        return new Date(now.getTime() + amount * 60000)
      case 'hour':
        return new Date(now.getTime() + amount * 3600000)
      case 'day':
        return new Date(now.getTime() + amount * 86400000)
      case 'week':
        return new Date(now.getTime() + amount * 604800000)
      case 'month': {
        const result = new Date(now)
        result.setMonth(result.getMonth() + amount)
        return result
      }
    }
  }

  // Try natural language parsing with chrono
  // Remove "at " prefix if present
  const dateString = normalized.replace(/^at\s+/i, '')

  // Build chrono parsing options with timezone (default to UTC)
  // chrono-node only accepts numeric offsets, not IANA names
  const parsed = chrono.parseDate(dateString, {
    timezone: ianaToOffsetMinutes(timezone || 'UTC'),
  })

  if (parsed) {
    // Ensure the time is in the future
    if (parsed.getTime() <= Date.now()) {
      throw new Error(`Scheduled time "${expression}" is in the past`)
    }
    return parsed
  }

  throw new Error(`Invalid 'at' expression: "${expression}"`)
}

/**
 * Validate "at" syntax and return the next execution time.
 */
export function validateAtSyntax(expression: string, timezone?: string): ParseResult {
  try {
    const nextTime = parseAtSyntax(expression, timezone)
    return { valid: true, nextTime }
  } catch (error) {
    return { valid: false, error: String(error) }
  }
}

/**
 * Get the next execution time for a cron expression.
 * When timezone is provided, cron-parser interprets the expression in that timezone
 * and handles DST transitions automatically.
 */
export function getNextCronTime(cronExpression: string, timezone?: string): Date {
  const interval = CronExpressionParser.parse(cronExpression, {
    tz: timezone || 'UTC',
  })
  return interval.next().toDate()
}

/**
 * Recommended minimum interval for recurring (cron) schedules. Recurring tasks
 * more frequent than this can pile up if a run outlasts the interval and rack up
 * cost on expensive models — so we surface a warning below this threshold (the
 * schedule is still allowed). 15 minutes.
 */
export const MIN_RECURRING_INTERVAL_MS = 15 * 60 * 1000

/**
 * Number of upcoming occurrences to scan when measuring how frequently a cron
 * fires. Comparing only the next two runs is time-dependent for bursty schedules
 * (e.g. "0,5 * * * *" looks like a 55-minute gap at :02 but a 5-minute gap at
 * :58), so we scan a small horizon and take the smallest gap. 32 covers
 * intra-hour bursts and any realistic daily/weekly burst while staying cheap.
 */
const CRON_OCCURRENCE_SCAN_COUNT = 32

/**
 * Compute the smallest gap (in milliseconds) between consecutive runs of a cron
 * expression over the next CRON_OCCURRENCE_SCAN_COUNT occurrences. Returns null
 * if the expression is invalid.
 *
 * Scanning a horizon (rather than just the next two runs) makes the result
 * independent of the current time and catches bursty schedules whose tightest
 * gap isn't between the immediate next two occurrences.
 */
export function getMinCronIntervalMs(cronExpression: string, timezone?: string): number | null {
  try {
    const interval = CronExpressionParser.parse(cronExpression, {
      tz: timezone || 'UTC',
    })
    let prev = interval.next().toDate().getTime()
    let minGap = Infinity
    for (let i = 0; i < CRON_OCCURRENCE_SCAN_COUNT; i++) {
      const next = interval.next().toDate().getTime()
      minGap = Math.min(minGap, next - prev)
      prev = next
    }
    return Number.isFinite(minGap) ? minGap : null
  } catch {
    return null
  }
}

/**
 * Format a millisecond interval as a short human-readable string (e.g. "1 minute",
 * "30 seconds", "10 minutes").
 */
function formatInterval(ms: number): string {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000))
    return `${seconds} second${seconds === 1 ? '' : 's'}`
  }
  const minutes = Math.round(ms / 60_000)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * Build a warning for recurring schedules that fire more often than
 * MIN_RECURRING_INTERVAL_MS. Returns null for one-time ("at") schedules,
 * unparseable expressions, or intervals at/above the threshold.
 *
 * Shared by the agent tool path (message-persister) and the manual API path
 * (scheduled-tasks route) so both surface identical guidance.
 */
export function getFrequencyWarning(
  scheduleType: 'at' | 'cron',
  scheduleExpression: string,
  timezone?: string
): string | null {
  if (scheduleType !== 'cron') return null

  const intervalMs = getMinCronIntervalMs(scheduleExpression, timezone)
  if (intervalMs === null || intervalMs >= MIN_RECURRING_INTERVAL_MS) return null

  const thresholdMinutes = Math.round(MIN_RECURRING_INTERVAL_MS / 60_000)
  return (
    `⚠️ Frequent schedule warning: this recurring task runs about every ${formatInterval(intervalMs)}, ` +
    `under the recommended ${thresholdMinutes}-minute minimum.\n` +
    `- Runs can pile up if a single execution takes longer than the interval. Overlapping runs are automatically skipped ` +
    `(a new run won't start while the previous one is still active), so the effective rate may be lower than requested.\n` +
    `- Frequent runs add up in cost — especially on Opus or at high effort.\n` +
    `Consider a longer interval unless this frequency is genuinely required.`
  )
}

/**
 * Soft-cap thresholds for how many active schedules a single agent holds. These
 * are purely informational — we never block creation, only warn so the agent (or
 * a human reading the tool result) can spot a runaway loop or a self-replicating
 * scheduled prompt (a cron whose prompt schedules another task). The per-task
 * overlap guard can't catch this because each task has a distinct ID.
 *
 *   count > SCHEDULE_COUNT_WARN_THRESHOLD     → warning
 *   count > SCHEDULE_COUNT_CRITICAL_THRESHOLD → critical warning
 *
 * The warn threshold is intentionally conservative; since nothing is prevented,
 * the occasional false alarm is acceptable.
 */
export const SCHEDULE_COUNT_WARN_THRESHOLD = 4
export const SCHEDULE_COUNT_CRITICAL_THRESHOLD = 6

/**
 * Build a soft-cap warning for an agent that holds many active schedules. Returns
 * null at or below the warn threshold (no warning), a warning above it, and a
 * critical warning above the critical threshold. Non-blocking by design — the
 * caller still creates the schedule and returns the full active list so the agent
 * can judge whether the count is legitimate.
 */
export function getScheduleCountWarning(activeCount: number): string | null {
  if (activeCount > SCHEDULE_COUNT_CRITICAL_THRESHOLD) {
    return (
      `🚨 CRITICAL: this agent now has ${activeCount} active schedules. ` +
      `This is unusually high and often means a runaway loop or a self-replicating scheduled prompt ` +
      `(a recurring task whose prompt schedules yet another task). ` +
      `Review the active schedules listed below and cancel any duplicates, overlaps, or tasks you did not intend to create.`
    )
  }
  if (activeCount > SCHEDULE_COUNT_WARN_THRESHOLD) {
    return (
      `⚠️ Schedule count warning: this agent now has ${activeCount} active schedules. ` +
      `If you did not mean to accumulate this many, review the list below for duplicates or overlapping schedules and cancel any that are unneeded.`
    )
  }
  return null
}

/**
 * Validate a cron expression and return the next execution time.
 */
export function validateCronExpression(cronExpression: string, timezone?: string): ParseResult {
  try {
    const interval = CronExpressionParser.parse(cronExpression, {
      tz: timezone || 'UTC',
    })
    const nextTime = interval.next().toDate()
    return { valid: true, nextTime }
  } catch (error) {
    return { valid: false, error: String(error) }
  }
}

/**
 * Validate a schedule expression based on its type.
 */
export function validateScheduleExpression(
  scheduleType: 'at' | 'cron',
  expression: string,
  timezone?: string
): ParseResult {
  if (scheduleType === 'at') {
    return validateAtSyntax(expression, timezone)
  } else {
    return validateCronExpression(expression, timezone)
  }
}

/**
 * Format a schedule expression for display.
 */
export function formatScheduleDescription(
  scheduleType: 'at' | 'cron',
  expression: string
): string {
  if (scheduleType === 'at') {
    try {
      const nextTime = parseAtSyntax(expression)
      return `One-time: ${nextTime.toLocaleString()}`
    } catch {
      return `One-time: ${expression}`
    }
  } else {
    return `Recurring: ${expression}`
  }
}

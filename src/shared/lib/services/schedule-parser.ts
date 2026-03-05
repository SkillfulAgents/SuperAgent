/**
 * Schedule Parser Utility
 *
 * Parses and validates schedule expressions for the scheduled task system.
 * Supports both "at" syntax for one-time tasks and cron syntax for recurring tasks.
 * All parsing is timezone-aware via an optional IANA timezone parameter.
 */

import { CronExpressionParser } from 'cron-parser'
import * as chrono from 'chrono-node'

export interface ParseResult {
  valid: boolean
  nextTime?: Date
  error?: string
}

/**
 * Get the UTC offset in minutes for a given IANA timezone at the current moment.
 * Returns a positive number for timezones east of UTC (e.g. +480 for Asia/Shanghai).
 * chrono-node expects offsets in this sign convention.
 */
function getTimezoneOffsetMinutes(timezone: string): number {
  const now = new Date()
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' })
  const tzStr = now.toLocaleString('en-US', { timeZone: timezone })
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
 *
 * @param timezone IANA timezone identifier (e.g. "Asia/Shanghai"). Defaults to UTC.
 */
export function parseAtSyntax(expression: string, timezone?: string): Date {
  const normalized = expression.trim().toLowerCase()

  // "at now + N unit" is timezone-agnostic (pure offset from current instant)
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

  const dateString = normalized.replace(/^at\s+/i, '')

  const refDate = new Date()
  const tz = timezone && timezone !== 'UTC' ? timezone : undefined
  const offsetMinutes = tz ? getTimezoneOffsetMinutes(tz) : undefined

  const parsed = chrono.parseDate(dateString, {
    instant: refDate,
    timezone: offsetMinutes,
  }, { forwardDate: true })

  if (parsed) {
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
 * @param timezone IANA timezone identifier (e.g. "Asia/Shanghai"). Defaults to UTC.
 */
export function getNextCronTime(cronExpression: string, timezone?: string): Date {
  const options = timezone ? { tz: timezone } : undefined
  const interval = CronExpressionParser.parse(cronExpression, options)
  return interval.next().toDate()
}

/**
 * Validate a cron expression and return the next execution time.
 */
export function validateCronExpression(cronExpression: string, timezone?: string): ParseResult {
  try {
    const options = timezone ? { tz: timezone } : undefined
    const interval = CronExpressionParser.parse(cronExpression, options)
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
  expression: string,
  timezone?: string
): string {
  if (scheduleType === 'at') {
    try {
      const nextTime = parseAtSyntax(expression, timezone)
      return `One-time: ${nextTime.toLocaleString(undefined, { timeZone: timezone })}`
    } catch {
      return `One-time: ${expression}`
    }
  } else {
    return `Recurring: ${expression}`
  }
}

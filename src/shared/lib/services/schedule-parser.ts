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

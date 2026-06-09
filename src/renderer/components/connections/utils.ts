import { formatDistanceStrict } from 'date-fns'
import { enUS } from 'date-fns/locale'
import type { Locale } from 'date-fns'

// MCP `mappedAt` can be a numeric-string epoch in ms; OAuth `createdAt` is
// an ISO string. The numeric branch only protects the MCP case.
export function safeDate(value: string | number): Date {
  if (typeof value === 'number') return new Date(value)
  const num = Number(value)
  return Number.isFinite(num) ? new Date(num) : new Date(value)
}

// `formatDistanceStrict` only ever emits the exact-unit tokens (xSeconds,
// xMinutes, ...) — never the "about"/"almost" variants.
const COMPACT_UNITS: Record<string, string> = {
  xMinutes: 'm',
  xHours: 'h',
  xDays: 'd',
  xMonths: 'mo',
  xYears: 'y',
}

const compactDistanceLocale: Locale = {
  ...enUS,
  formatDistance: (token, count, options) => {
    if (token === 'xSeconds') return 'just now'
    const unit = COMPACT_UNITS[token]
    if (!unit) return enUS.formatDistance(token, count, options)
    return options?.addSuffix ? `${count}${unit} ago` : `${count}${unit}`
  },
}

/**
 * Compact relative timestamp — "just now", "5m ago", "3h ago", "2d ago",
 * "2mo ago", "1y ago". Designed for dense row metadata where
 * "5 minutes ago" is too long. Unit boundaries come from date-fns
 * `formatDistanceStrict`, which has no weeks tier (10 days → "10d ago").
 * Returns '' for invalid dates (`safeDate` can produce one).
 */
export function formatCompactDistance(date: Date, now: Date = new Date()): string {
  if (Number.isNaN(date.getTime())) return ''
  // Clamp future dates (clock skew) to "just now" rather than "in 5m".
  const past = date.getTime() > now.getTime() ? now : date
  return formatDistanceStrict(past, now, { addSuffix: true, locale: compactDistanceLocale })
}

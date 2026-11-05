import { differenceInCalendarMonths, format, isValid } from 'date-fns'

/** The full date and time, for a tooltip. */
export function formatMessageTimeExact(date: Date): string {
  return isValid(date) ? format(date, 'PPpp') : ''
}

/**
 * How long ago, in compact units: "just now", "5m ago", "16h ago", "3d ago",
 * "2w ago", "4mo ago", "1y ago". Whole units, rounded down.
 */
export function formatShortAgo(date: Date, now: Date = new Date()): string {
  if (!isValid(date)) return ''
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const months = differenceInCalendarMonths(now, date)
  if (months < 1 || days < 28) return `${Math.floor(days / 7)}w ago`
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

import { formatDistanceToNow } from 'date-fns'

/**
 * "Last active 3 hours ago" for an agent's or session's last activity, or null
 * when there is none. One wording for every surface that shows it — the
 * search dialog, the home grid's agent cards and the sidebar's agent rows.
 */
export function formatLastRun(date: Date | string | null | undefined): string | null {
  if (!date) return null
  return `Last active ${formatDistanceToNow(new Date(date), { addSuffix: true })}`
}

/** Compact relative age: now, 4m, 1h, 2d. */
export function compactAgo(date: Date | string | null | undefined): string | null {
  if (!date) return null
  const mins = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60_000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

import { formatDistanceToNow } from 'date-fns'

/**
 * "Last run 3 hours ago" for an agent's or session's last activity, or null
 * when there is none. One wording for every surface that shows it — the
 * search dialog, the home grid's agent cards and the sidebar's agent rows.
 */
export function formatLastRun(date: Date | string | null | undefined): string | null {
  if (!date) return null
  return `Last run ${formatDistanceToNow(new Date(date), { addSuffix: true })}`
}

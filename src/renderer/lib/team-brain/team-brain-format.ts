import type { TeamBrainSchedule } from './team-brain-schema'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "12 min ago", "3 h ago", "yesterday", "6 days ago". */
export function formatMinutesAgo(minutes: number): string {
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${Math.round(minutes)} min ago`
  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)} h ago`
  const days = Math.round(hours / 24)
  if (days <= 1) return 'yesterday'
  return `${days} days ago`
}

/** Relative time for a stored ISO timestamp; "never" when there is none. */
export function formatSince(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never'
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return 'never'
  return formatMinutesAgo((now - at) / MINUTE)
}

/** "in 47 min", "in 11 h", "in 6 days": how long until a time. */
export function formatUntil(at: Date | string, now: number = Date.now()): string {
  const remaining = Math.max(new Date(at).getTime() - now, 0)
  if (remaining < MINUTE) return 'any moment'
  if (remaining < HOUR) return `in ${Math.round(remaining / MINUTE)} min`
  if (remaining < DAY) return `in ${Math.round(remaining / HOUR)} h`
  const days = Math.round(remaining / DAY)
  return days <= 1 ? 'tomorrow' : `in ${days} days`
}

/** Each sync schedule's name, and the trade-off it makes between fresh context and cost. */
export const SCHEDULE_LABELS: Record<TeamBrainSchedule, { title: string; detail: string }> = {
  hourly: { title: 'Every hour', detail: 'Freshest. Up to 24 syncs a day, so it costs the most.' },
  daily: { title: 'Daily', detail: 'Overnight, ready by morning. One sync a day keeps costs low.' },
  weekly: { title: 'Weekly', detail: 'Cheapest. Agents can be up to a week behind.' },
}

/** "Today", "Yesterday" or "Mon, Oct 19": the day a sync ran. */
export function formatSyncDay(at: Date, now: Date = new Date()): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(at)) / DAY)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(at.getFullYear() !== now.getFullYear() && { year: 'numeric' }) })
}

/** "9:02 AM": the time a sync ran. */
export function formatSyncTime(at: Date): string {
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

const pageCount = (n: number) => `${n} page${n === 1 ? '' : 's'}`

/** "3 pages added, 9 updated", the way a release has its number. Counts the agent got wrong read as none, so its lines say what it filed. */
export function syncCountLabel({ added, updated, changes }: { added: number; updated: number; changes: readonly string[] }): string {
  if (added && updated) return `${pageCount(added)} added, ${updated} updated`
  if (added || updated) return added ? `${pageCount(added)} added` : `${pageCount(updated)} updated`
  return changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'No changes'
}

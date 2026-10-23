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

/** Each sync schedule's name, and the trade-off it makes between fresh context and cost. */
export const SCHEDULE_LABELS: Record<TeamBrainSchedule, { title: string; detail: string }> = {
  hourly: { title: 'Every hour', detail: 'Freshest. Up to 24 syncs a day, so it costs the most.' },
  daily: { title: 'Daily', detail: 'Overnight, ready by morning. One sync a day keeps costs low.' },
  weekly: { title: 'Weekly', detail: 'Cheapest. Agents can be up to a week behind.' },
}

const SCHEDULE_PERIOD: Record<TeamBrainSchedule, number> = {
  hourly: HOUR,
  daily: DAY,
  weekly: 7 * DAY,
}

/** "in 47 min", "in 11 h", "in 6 days" — when the schedule next fires after the last sync. */
export function formatNextSync(schedule: TeamBrainSchedule, lastSyncAt: string | null, now: number = Date.now()): string {
  const last = lastSyncAt ? new Date(lastSyncAt).getTime() : now
  const base = Number.isNaN(last) ? now : last
  const remaining = Math.max(base + SCHEDULE_PERIOD[schedule] - now, 0)
  if (remaining < MINUTE) return 'any moment'
  if (remaining < HOUR) return `in ${Math.round(remaining / MINUTE)} min`
  if (remaining < DAY) return `in ${Math.round(remaining / HOUR)} h`
  const days = Math.round(remaining / DAY)
  return days <= 1 ? 'tomorrow' : `in ${days} days`
}

/** When each of the last `count` syncs ran, newest first: the last sync, then one schedule period further back each. */
export function syncTimes(schedule: TeamBrainSchedule, lastSyncAt: string | null, count: number, now: number = Date.now()): Date[] {
  const last = lastSyncAt ? new Date(lastSyncAt).getTime() : now
  const base = Number.isNaN(last) ? now : last
  return Array.from({ length: count }, (_, i) => new Date(base - i * SCHEDULE_PERIOD[schedule]))
}

/** "Today", "Yesterday" or "Mon, Oct 19": the day a sync ran. */
export function formatSyncDay(at: Date, now: Date = new Date()): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(at)) / DAY)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

/** "9:02 AM": the time a sync ran. */
export function formatSyncTime(at: Date): string {
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

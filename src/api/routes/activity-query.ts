import {
  DEFAULT_ACTIVITY_DAYS,
  MAX_ACTIVITY_DAYS,
  MIN_ACTIVITY_DAYS,
} from '@shared/lib/types/activity'

export function parseActivityDays(raw: string | undefined): number {
  if (!raw) return DEFAULT_ACTIVITY_DAYS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_ACTIVITY_DAYS
  return Math.min(MAX_ACTIVITY_DAYS, Math.max(MIN_ACTIVITY_DAYS, parsed))
}

// Viewer's Date.prototype.getTimezoneOffset(): real-world values span
// UTC+14 (-840) to UTC-12 (+720); anything outside is a bogus client.
export function parseActivityTzOffset(raw: string | undefined): number {
  if (!raw) return 0
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return 0
  return Math.min(840, Math.max(-840, parsed))
}

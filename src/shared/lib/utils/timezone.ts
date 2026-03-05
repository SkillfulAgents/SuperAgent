/**
 * Timezone formatting utilities shared across frontend and backend.
 */

/** The host system's IANA timezone identifier (e.g. "America/Los_Angeles"). */
export const systemTimezone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export function formatDateWithTimezone(date: Date | string | number, timezone: string): string {
  return new Date(date).toLocaleString(undefined, { timeZone: timezone, timeZoneName: 'short' })
}

export function formatDateOnlyWithTimezone(date: Date | string | number, timezone: string): string {
  return new Date(date).toLocaleDateString(undefined, { timeZone: timezone })
}

/**
 * Format a Date to yyyyMMdd or yyyy-MM-dd in the given IANA timezone.
 */
export function formatDateKeyInTimezone(date: Date, timezone: string, separator = ''): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const y = parts.find(p => p.type === 'year')!.value
  const m = parts.find(p => p.type === 'month')!.value
  const d = parts.find(p => p.type === 'day')!.value
  return `${y}${separator}${m}${separator}${d}`
}

/**
 * Timezone utilities shared across frontend and backend.
 *
 * TODO: Add formatting helpers (formatDateWithTimezone, formatDateKeyInTimezone, etc.)
 * when timezone-aware UI or usage reports are implemented.
 */

/** The host system's IANA timezone identifier (e.g. "America/Los_Angeles"). */
export const systemTimezone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

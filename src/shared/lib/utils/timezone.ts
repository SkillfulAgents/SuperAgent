/**
 * Timezone utilities shared across frontend and backend.
 */

/** The host system's IANA timezone identifier (e.g. "America/Los_Angeles"). */
export const systemTimezone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

import { useSettings } from './use-settings'

export { formatDateWithTimezone, formatDateOnlyWithTimezone } from '@shared/lib/utils/timezone'

/**
 * Returns the globally configured timezone (IANA identifier).
 * Falls back to the browser's timezone if not set.
 */
export function useTimezone(): string {
  const { data: settings } = useSettings()
  return settings?.app?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

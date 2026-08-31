export const DEFAULT_API_LOG_AUTO_DELETE_DAYS = 30

export const API_LOG_AUTO_DELETE_DAY_OPTIONS = [30, 60, 90] as const

/** 0 = Never (keep forever). Unset app+agent falls back to 30. */
export function resolveApiLogAutoDeleteDays(
  agentDays: number | undefined,
  appDays: number | undefined,
): number {
  if (agentDays !== undefined) return agentDays
  if (appDays !== undefined) return appDays
  return DEFAULT_API_LOG_AUTO_DELETE_DAYS
}

import { useUserSettings } from './use-user-settings'

/**
 * Whether the user has opted into dot-matrix status indicators (replacing the
 * classic single dot / 3-dot wave). Defaults to false (classic) while loading
 * or unset.
 */
export function useDotMatrixIndicators(): boolean {
  const { data } = useUserSettings()
  return data?.dotMatrixIndicators ?? false
}

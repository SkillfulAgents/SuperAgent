import { z } from 'zod'
import { permissionLevelOf } from './commands'

/**
 * Computer Use Permission & Request Types
 *
 * Three permission levels control what agents can do:
 * - list_apps_windows: read-only (list-apps, list-windows, list-displays, status)
 * - use_application: interact with a specific app (snapshot, click, type, launch, ...)
 * - use_host_shell: shell commands / AppleScript (replaces old hostShellUse toggle)
 */

export type ComputerUsePermissionLevel =
  | 'list_apps_windows'
  | 'use_application'
  | 'use_host_shell'

/** User-facing names for the permission levels, shared by the settings tab and
    the in-chat approval card. Written to be self-explanatory without a legend. */
export const PERMISSION_LEVEL_LABELS: Record<ComputerUsePermissionLevel, string> = {
  list_apps_windows: 'List Apps & Windows (read-only)',
  use_application: 'Use Application',
  use_host_shell: 'Run Shell Commands & Scripts',
}

export type PermissionGrantType = 'once' | 'timed' | 'always'

export interface PermissionGrant {
  level: ComputerUsePermissionLevel
  /** Only for 'use_application' — the specific app name */
  appName?: string
  grantType: PermissionGrantType
  grantedAt: number
  /** Only for 'timed' grants (15 min) */
  expiresAt?: number
}

/**
 * Whether agents may send physical input: agent-desktop's `--headed`, which
 * an agent passes when a command needs it (double-click, hover, drag, a click
 * at screen coordinates). It moves the pointer and takes focus.
 * - headed: allowed.
 * - headless: refused, so commands stay on accessibility calls and the user
 *   can keep working.
 */
export const COMPUTER_USE_INPUT_MODES = ['headed', 'headless'] as const

export type ComputerUseInputMode = typeof COMPUTER_USE_INPUT_MODES[number]

/** Persisted in settings.json — only 'always' grants are stored */
export interface ComputerUseSettings {
  agentPermissions?: Record<string, {
    grants: Array<{
      level: ComputerUsePermissionLevel
      appName?: string
      grantType: 'always'
    }>
  }>
  /** Draw each agent's cursor (its name and colour) where it acts. Default on. */
  showCursor?: boolean
  /** Default 'headed'. */
  inputMode?: ComputerUseInputMode
}

export interface ComputerUsePreferences {
  showCursor: boolean
  inputMode: ComputerUseInputMode
}

export const DEFAULT_COMPUTER_USE_PREFERENCES: ComputerUsePreferences = {
  showCursor: true,
  inputMode: 'headed',
}

/** The stored cursor and input settings; a value of the wrong kind (a hand edit) reads as unset. */
const storedPreferencesSchema = z.object({
  showCursor: z.boolean().optional().catch(undefined),
  inputMode: z.enum(COMPUTER_USE_INPUT_MODES).optional().catch(undefined),
})

/** The cursor and input settings, with their defaults filled in. */
export function computerUsePreferences(settings: ComputerUseSettings | undefined): ComputerUsePreferences {
  const stored = storedPreferencesSchema.safeParse(settings ?? {}).data ?? {}
  return {
    showCursor: stored.showCursor ?? DEFAULT_COMPUTER_USE_PREFERENCES.showCursor,
    inputMode: stored.inputMode ?? DEFAULT_COMPUTER_USE_PREFERENCES.inputMode,
  }
}

/**
 * Determine the permission level required for a computer-use command.
 */
export function getRequiredPermissionLevel(method: string, params: Record<string, unknown> = {}): ComputerUsePermissionLevel {
  try {
    return permissionLevelOf(method, params)
  } catch {
    // Arguments it cannot read are refused when the command runs; until then
    // the call needs the stronger level.
    return 'use_application'
  }
}

/** Duration of "timed" permission grants in milliseconds (15 minutes) */
export const TIMED_GRANT_DURATION_MS = 15 * 60 * 1000

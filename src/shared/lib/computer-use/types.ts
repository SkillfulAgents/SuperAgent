/**
 * Computer Use Permission & Request Types
 *
 * Three permission levels control what agents can do:
 * - list_apps_windows: read-only (ac apps, ac windows, ac status, ac displays)
 * - use_application: interact with a specific app (click, type, launch, grab, etc.)
 * - use_host_shell: shell commands / AppleScript (replaces old hostShellUse toggle)
 */

export type ComputerUsePermissionLevel =
  | 'list_apps_windows'
  | 'use_application'
  | 'use_host_shell'

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

/** Persisted in settings.json — only 'always' grants are stored */
export interface ComputerUseSettings {
  agentPermissions?: Record<string, {
    grants: Array<{
      level: ComputerUsePermissionLevel
      appName?: string
      grantType: 'always'
    }>
  }>
}

/** SSE event broadcast when a computer use request needs user approval */
export interface ComputerUseRequestEvent {
  type: 'computer_use_request'
  toolUseId: string
  method: string
  params: Record<string, unknown>
  permissionLevel: ComputerUsePermissionLevel
  appName?: string
  agentSlug?: string
}

/** Read-only AC methods that only need list_apps_windows permission */
export const READ_ONLY_METHODS = new Set([
  'apps', 'windows', 'status', 'displays', 'permissions',
])

/**
 * Determine the permission level required for an AC method.
 */
export function getRequiredPermissionLevel(method: string): ComputerUsePermissionLevel {
  if (READ_ONLY_METHODS.has(method)) return 'list_apps_windows'
  return 'use_application'
}

/** Duration of "timed" permission grants in milliseconds (15 minutes) */
export const TIMED_GRANT_DURATION_MS = 15 * 60 * 1000

/**
 * Resolve which app an AC method call targets, for permission checks.
 * Returns the app name if determinable, undefined otherwise.
 */
export function resolveTargetApp(
  method: string,
  params: Record<string, unknown>,
  grabbedApp?: string,
): string | undefined {
  if (params.app && typeof params.app === 'string') return params.app
  if (params.name && typeof params.name === 'string') return params.name
  if (method === 'grab') {
    if (params.app && typeof params.app === 'string') return params.app
    return undefined
  }
  return grabbedApp
}

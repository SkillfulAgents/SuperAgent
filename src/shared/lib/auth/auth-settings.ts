import { getSettings, DEFAULT_AUTH_SETTINGS, type AuthSettings } from '@shared/lib/config/settings'
import { isAuthMode } from './mode'

/** AUTH_MODE + PLATFORM_TOKEN = platform-controlled deployment (members managed on Platform). */
export function isPlatformControlledAuth(): boolean {
  return isAuthMode() && Boolean(process.env.PLATFORM_TOKEN?.trim())
}

/** Merge defaults with persisted auth; force no local approval gate when platform-controlled. */
export function resolveAuthSettings(auth?: AuthSettings | null): AuthSettings {
  const resolved = { ...DEFAULT_AUTH_SETTINGS, ...auth }
  // No local Users approve UI in env-managed mode — never ban pending approval.
  if (isPlatformControlledAuth()) {
    resolved.requireAdminApproval = false
  }
  return resolved
}

export function getAuthSettings(): AuthSettings {
  return resolveAuthSettings(getSettings().auth)
}

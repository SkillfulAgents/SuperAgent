import { getSettings, DEFAULT_AUTH_SETTINGS, type AuthSettings } from '@shared/lib/config/settings'
import { decodeOrgIdFromToken } from '@shared/lib/platform-auth/decode-org-id'
import { isAuthMode } from './mode'

/** AUTH_MODE + org JWT PLATFORM_TOKEN = platform-controlled (members managed on Platform). */
export function isPlatformControlledAuth(): boolean {
  return isAuthMode() && decodeOrgIdFromToken(process.env.PLATFORM_TOKEN ?? '') !== null
}

/** Merge defaults with persisted auth; close local signup/approval when platform-controlled. */
export function resolveAuthSettings(auth?: AuthSettings | null): AuthSettings {
  const resolved = { ...DEFAULT_AUTH_SETTINGS, ...auth }
  // No local Users approve UI / open signup in org-pinned mode — Platform owns membership.
  if (isPlatformControlledAuth()) {
    resolved.requireAdminApproval = false
    resolved.signupMode = 'closed'
  }
  return resolved
}

export function getAuthSettings(): AuthSettings {
  return resolveAuthSettings(getSettings().auth)
}

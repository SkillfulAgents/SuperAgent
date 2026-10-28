import { getSettings } from '@shared/lib/config/settings'

/**
 * Get trusted origins, env-first.
 *
 * The TRUSTED_ORIGINS env var is the documented deployment interface (README:
 * "the first origin is also used as the app's base URL"), so it must win over
 * settings.json — it feeds Better Auth's baseURL/CSRF config and the audience
 * the RFC 7523 token endpoint verifies grants against.
 */
export function getTrustedOrigins(): string[] {
  const fromEnv = (process.env.TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  if (fromEnv.length > 0) {
    return fromEnv
  }
  const settings = getSettings()
  return settings.auth?.trustedOrigins ?? []
}


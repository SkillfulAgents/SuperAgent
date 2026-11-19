import { getSettings, type AppSettings } from '@shared/lib/config/settings'

/**
 * Trusted origins, env-first, from settings already read.
 *
 * The TRUSTED_ORIGINS env var is the documented deployment interface (README:
 * "the first origin is also used as the app's base URL"), so it must win over
 * settings — it feeds Better Auth's baseURL/CSRF config and the audience the
 * RFC 7523 token endpoint verifies grants against.
 */
export function trustedOriginsFrom(settings: Pick<AppSettings, 'auth'>): string[] {
  const fromEnv = (process.env.TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  if (fromEnv.length > 0) {
    return fromEnv
  }
  return settings.auth?.trustedOrigins ?? []
}

/** Trusted origins from the current settings (see {@link trustedOriginsFrom}). */
export async function getTrustedOrigins(): Promise<string[]> {
  return trustedOriginsFrom(await getSettings())
}

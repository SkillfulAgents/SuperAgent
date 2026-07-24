import type { Context } from 'hono'
import { getSettings } from '@shared/lib/config/settings'
import { isAuthMode } from './mode'

/**
 * Get the app's external base URL (no trailing slash).
 * Priority: trustedOrigins (first entry) > HOST/PORT/USE_HTTPS env vars > defaults.
 *
 * Used for Better Auth baseURL, OAuth callback URLs, and anywhere
 * we need the externally-reachable origin of this server.
 */
export function getAppBaseUrl(): string {
  const origins = getTrustedOrigins()
  if (origins.length > 0) {
    return origins[0]
  }
  const host = process.env.HOST || 'localhost'
  const port = process.env.PORT || '47891'
  const protocol = process.env.USE_HTTPS === 'true' ? 'https' : 'http'
  return `${protocol}://${host}:${port}`
}

/**
 * Get the app's base URL from a request context.
 * Uses getAppBaseUrl() when configured, otherwise falls back to the
 * request's origin header or URL — useful for OAuth callbacks.
 */
export function getAppBaseUrlFromRequest(c: Context): string {
  const configured = getTrustedOrigins()
  if (configured.length > 0) {
    return configured[0]
  }
  if (process.env.HOST) {
    return getAppBaseUrl()
  }
  // Fall back to request origin (same as current behavior for unconfigured setups)
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  return c.req.header('origin') || new URL(c.req.url).origin
}

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

/**
 * Get the current user ID from the request context.
 * Returns 'local' sentinel in non-auth mode (single-user).
 */
export function getCurrentUserId(c: Context): string {
  if (!isAuthMode()) return 'local'
  const user = c.get('user' as never) as { id: string } | undefined
  if (!user) throw new Error('User not found in context — Authenticated middleware missing?')
  return user.id
}

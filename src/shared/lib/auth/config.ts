import type { Context } from 'hono'
import { getTrustedOrigins } from './trusted-origins'
import { isAuthMode } from './mode'

export { getTrustedOrigins, trustedOriginsFrom } from './trusted-origins'

/**
 * The app's external base URL (no trailing slash), from trusted origins
 * already resolved. Priority: trustedOrigins (first entry) >
 * HOST/PORT/USE_HTTPS env vars > defaults.
 */
export function appBaseUrlFrom(origins: readonly string[]): string {
  if (origins.length > 0) {
    return origins[0]
  }
  const host = process.env.HOST || 'localhost'
  const port = process.env.PORT || '47891'
  const protocol = process.env.USE_HTTPS === 'true' ? 'https' : 'http'
  return `${protocol}://${host}:${port}`
}

/**
 * Get the app's external base URL (no trailing slash), from the current
 * settings. Used for Better Auth baseURL, OAuth callback URLs, and anywhere
 * we need the externally-reachable origin of this server.
 */
export async function getAppBaseUrl(): Promise<string> {
  return appBaseUrlFrom(await getTrustedOrigins())
}

/**
 * Get the app's base URL from a request context.
 * Uses getAppBaseUrl() when configured, otherwise falls back to the
 * request's origin header or URL — useful for OAuth callbacks.
 */
export async function getAppBaseUrlFromRequest(c: Context): Promise<string> {
  const configured = await getTrustedOrigins()
  if (configured.length > 0) {
    return configured[0]
  }
  if (process.env.HOST) {
    return appBaseUrlFrom(configured)
  }
  // Fall back to request origin (same as current behavior for unconfigured setups)
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  return c.req.header('origin') || new URL(c.req.url).origin
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

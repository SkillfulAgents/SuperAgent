import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { verifyDashboardCookie, DASHBOARD_COOKIE_NAME } from '@shared/lib/telegram/dashboard-cookie'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'

/**
 * TelegramDashboardSession — establishes a trusted user context from a signed
 * Telegram dashboard cookie.
 *
 * Behaviour:
 * - No cookie → pass through (downstream guards handle rejection).
 * - Invalid cookie (bad sig / expired / malformed) → pass through.
 * - Artifact route (has `:id` param) + slug mismatch → pass through.
 * - Otherwise → set `c.get('user')` to `{ id: payload.userId }` and continue.
 *
 * This middleware never rejects requests; it only sets the user when entitled.
 */
export function TelegramDashboardSession(): MiddlewareHandler {
  return async (c, next) => {
    const raw = getCookie(c, DASHBOARD_COOKIE_NAME)
    if (!raw) return next()

    const payload = verifyDashboardCookie(raw, getOrCreateAuthSecret())
    if (!payload) return next()

    const routeAgent = c.req.param('id')
    if (routeAgent !== undefined && routeAgent !== payload.agentSlug) return next()

    c.set('user' as never, { id: payload.userId } as never)
    return next()
  }
}

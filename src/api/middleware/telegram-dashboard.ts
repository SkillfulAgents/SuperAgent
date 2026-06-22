import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { verifyDashboardCookie, DASHBOARD_COOKIE_NAME } from '@shared/lib/telegram/dashboard-cookie'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'

/**
 * shouldRunDashboardSession — decides whether the dashboard cookie may even be
 * consulted on this request. Mounted on `:artifactSlug/*`, which in Hono 4 also
 * fires on the bare `:artifactSlug` management path (AgentAdmin DELETE/PATCH).
 *
 * Two independent guards, either of which is sufficient:
 * - A dashboard cookie only ever grants reads, so it must never be consulted on
 *   a mutating method. Gate to GET/HEAD.
 * - On the bare management path (no content after the slug) the cookie must not
 *   apply. Compare against the DECODED path: Hono keeps `%2F` in `c.req.path`
 *   but decodes `c.req.param()`, so reconstructing from params would let a
 *   `%2F`-encoded slug evade a raw-path comparison. Fail closed on bad encoding.
 *
 * Exported so the real predicate is what gets tested, not a copy.
 */
export function shouldRunDashboardSession(c: Context): boolean {
  const method = c.req.method
  if (method !== 'GET' && method !== 'HEAD') return false

  const artifactSlug = c.req.param('artifactSlug')
  if (artifactSlug === undefined) return true // non-artifact routes (llm/stt)

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(c.req.path)
  } catch {
    return false
  }
  const barePath = `/api/agents/${c.req.param('id')}/artifacts/${artifactSlug}`
  return decodedPath !== barePath
}

/**
 * TelegramDashboardSession — establishes a trusted user context from a signed
 * Telegram dashboard cookie.
 *
 * Behaviour:
 * - No cookie → pass through (downstream guards handle rejection).
 * - Invalid cookie (bad sig / expired / malformed) → pass through.
 * - Artifact route (has `:id` param) + agent mismatch → pass through.
 * - Artifact route (has `:artifactSlug` param) + dashboard mismatch → pass through.
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

    // Scope the cookie to the single dashboard it was minted for: a cookie for
    // dashboard A must not authorize reads of dashboard B under the same agent.
    const routeDashboard = c.req.param('artifactSlug')
    if (routeDashboard !== undefined && routeDashboard !== payload.dashboardSlug) return next()

    c.set('user' as never, { id: payload.userId } as never)
    return next()
  }
}

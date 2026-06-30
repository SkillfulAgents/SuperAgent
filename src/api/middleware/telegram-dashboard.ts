import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { verifyDashboardCookie, DASHBOARD_COOKIE_NAME } from '@shared/lib/telegram/dashboard-cookie'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'

/**
 * shouldRunDashboardSession — decides whether the dashboard cookie may be
 * consulted on this request. Mounted on `:artifactSlug/*`, which in Hono 4 also
 * fires on the bare `:artifactSlug` management path (AgentAdmin DELETE/PATCH).
 *
 * The cookie grants the same access an in-app AgentRead viewer has on a dashboard's
 * content sub-paths — including writes (POST/PUT/DELETE/PATCH) to the dashboard's
 * own backend — so the Telegram and in-app experiences match. That reachability is
 * bounded: every sub-path request hits only the
 * `agents.all('…/artifacts/:artifactSlug/*', AgentRead())` proxy, which forwards
 * into the agent's sandboxed container; no host-side mutation lives under a
 * sub-path. (A dashboard backend could already cause side effects on a GET, so
 * gating the method added little containment here — the container sandbox is the
 * real boundary, and the cookie can never reach SuperAgent's other host routes
 * because it is mounted only on the artifact, llm, and stt surfaces.)
 *
 * The one hard exclusion is the bare `:artifactSlug` management path (the
 * AgentAdmin DELETE/PATCH endpoints): the cookie must NEVER apply there, for any
 * method. Compare against the DECODED path — Hono keeps `%2F` in `c.req.path` but
 * decodes `c.req.param()`, so reconstructing from params would let a `%2F`-encoded
 * slug evade a raw-path comparison. Fail closed on bad encoding.
 *
 * Exported so the real predicate is what gets tested, not a copy.
 */
export function shouldRunDashboardSession(c: Context): boolean {
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

    const payload = await verifyDashboardCookie(raw, getOrCreateAuthSecret())
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

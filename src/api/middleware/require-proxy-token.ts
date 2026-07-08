import type { MiddlewareHandler } from 'hono'
import { validateProxyToken } from '@shared/lib/proxy/token-store'

/**
 * Bearer proxy-token gate for container-facing routes. Each such router applies it explicitly
 * (`.use('*', RequireProxyToken())`); nothing is inherited from sibling routers, so a route that
 * forgets the gate ships open. Mirrors the LocalModeAuth() middleware sibling — extracted on the
 * second occurrence (web-search + web-fetch) so the gate has one definition.
 */
export function RequireProxyToken(): MiddlewareHandler {
  return async (c, next) => {
    const token = c.req.header('Authorization')?.replace('Bearer ', '')
    if (!token) return c.json({ error: 'Unauthorized' }, 401)
    if (!(await validateProxyToken(token))) return c.json({ error: 'Unauthorized' }, 401)
    await next()
  }
}

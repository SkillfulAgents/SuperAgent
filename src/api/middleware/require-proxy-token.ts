import type { MiddlewareHandler } from 'hono'
import { runWithOptionalUser } from '@shared/lib/platform-attribution'
import { getAgentOwnerUserId } from '@shared/lib/services/agent-owner'
import { validateProxyToken } from '@shared/lib/proxy/token-store'

/**
 * Bearer proxy-token gate for container-facing routes. Each such router applies it explicitly
 * (`.use('*', RequireProxyToken())`); nothing is inherited from sibling routers, so a route that
 * forgets the gate ships open. Mirrors the LocalModeAuth() middleware sibling — extracted on the
 * second occurrence (web-search + web-fetch) so the gate has one definition.
 *
 * The token identifies an agent, not a user, so the handler runs under the agent OWNER's
 * attribution scope — the same shape Authenticated() gives a browser request. Without a scope
 * `attribution.current()` is null, the platform fetch interceptor leaves an org-scoped bearer with
 * no acting member, and the proxy bills the org with no seat (denying outright when the org is
 * seat-subscribed and holds no pool credits). A single-user install has no agent_acl row, so this
 * resolves to null and the call goes out on its already member-scoped access key, unchanged.
 */
export function RequireProxyToken(): MiddlewareHandler {
  return async (c, next) => {
    const token = c.req.header('Authorization')?.replace('Bearer ', '')
    if (!token) return c.json({ error: 'Unauthorized' }, 401)
    const agentSlug = await validateProxyToken(token)
    if (!agentSlug) return c.json({ error: 'Unauthorized' }, 401)
    return runWithOptionalUser(getAgentOwnerUserId(agentSlug), () => next())
  }
}

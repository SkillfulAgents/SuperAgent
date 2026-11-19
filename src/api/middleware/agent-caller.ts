import type { MiddlewareHandler } from 'hono'
import { validateProxyToken } from '@shared/lib/proxy/token-store'

/**
 * Who a container-to-host request is from: the agent its proxy token belongs to.
 *
 * `/api/x-agent` and the routers mounted beneath it (`/chat`, `/integrations`,
 * `/meetings`, `/rules`, `/sessions`, `/skills`) each guard themselves with this
 * middleware, and the parent's `use('*')` also matches the routes beneath it,
 * so one request passes through it twice. The token is looked up once: the
 * first pass records its answer against the request, and the second reads it.
 *
 * What makes the second pass safe to skip the lookup:
 * - the record is written only here, after `validateProxyToken` accepted the
 *   token. It is not a context variable, so no other middleware and nothing a
 *   client sends can put a caller there.
 * - it is keyed by the request object itself and holds the token it was
 *   answered for; a pass that sees another request, or another token on the
 *   same one, looks the token up.
 * - a router mounted somewhere the parent does not cover, or ahead of it, finds
 *   no record and looks the token up. Every router keeps its own guard, so none
 *   depends on where or in what order it is mounted.
 *
 * Only an accepted token is recorded. A refused one ends the request.
 */
const validated = new WeakMap<Request, { token: string; callerSlug: string }>()

export type AgentCallerVariables = { callerSlug: string }

export const requireAgentCaller: MiddlewareHandler<{ Variables: AgentCallerVariables }> = async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const request = c.req.raw
  const earlier = validated.get(request)
  let callerSlug: string | null
  if (earlier && earlier.token === token) {
    callerSlug = earlier.callerSlug
  } else {
    callerSlug = await validateProxyToken(token)
    if (callerSlug) validated.set(request, { token, callerSlug })
  }
  if (!callerSlug) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  c.set('callerSlug', callerSlug)
  await next()
}

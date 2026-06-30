// Container-to-host endpoint a remote agent VM hits once at boot to fetch its full
// env. Auth: Bearer PROXY_TOKEN whose resolved slug must match :agentSlug.

import { Hono } from 'hono'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { readBootstrapEnv } from '@shared/lib/container/agent-bootstrap-env-store'

const agentBootstrap = new Hono()

// TEMP debug (debug/microvm-bootstrap-env-logging): trace the boot fetch outcome
// without leaking token/env. Remove before merge.
function bootstrapRouteDebug(agentSlug: string, outcome: string, extra?: Record<string, unknown>): void {
  try {
    console.log(
      `[bootstrap-debug] ${JSON.stringify({ ts: new Date().toISOString(), event: 'route', agentSlug, outcome, pid: process.pid, ...extra })}`,
    )
  } catch {
    // never let logging break the route
  }
}

agentBootstrap.get('/:agentSlug/env', async (c) => {
  const agentSlug = c.req.param('agentSlug')
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  bootstrapRouteDebug(agentSlug, 'enter', { hasToken: Boolean(token) })
  if (!token) {
    bootstrapRouteDebug(agentSlug, '401-no-token')
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const callerSlug = await validateProxyToken(token)
  if (!callerSlug) {
    bootstrapRouteDebug(agentSlug, '401-bad-token')
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (callerSlug !== agentSlug) {
    bootstrapRouteDebug(agentSlug, '403-slug-mismatch', { callerSlug })
    return c.json({ error: 'Token does not match agent' }, 403)
  }
  // Idempotent: re-fetchable until the agent tears down (boot fetch may retry).
  const env = readBootstrapEnv(agentSlug)
  if (!env) {
    bootstrapRouteDebug(agentSlug, '404-no-env')
    return c.json({ error: 'No bootstrap env available' }, 404)
  }
  bootstrapRouteDebug(agentSlug, '200-ok', { envKeyCount: Object.keys(env).length })
  return c.json({ env })
})

export default agentBootstrap

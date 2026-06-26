// Container-to-host endpoint a remote agent VM hits once at boot to fetch its full
// env. Auth: Bearer PROXY_TOKEN whose resolved slug must match :agentSlug.

import { Hono } from 'hono'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { readBootstrapEnv } from '@shared/lib/container/agent-bootstrap-env-store'

const agentBootstrap = new Hono()

agentBootstrap.get('/:agentSlug/env', async (c) => {
  const agentSlug = c.req.param('agentSlug')
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const callerSlug = await validateProxyToken(token)
  if (!callerSlug) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (callerSlug !== agentSlug) {
    return c.json({ error: 'Token does not match agent' }, 403)
  }
  // Idempotent: re-fetchable until the agent tears down (boot fetch may retry).
  const env = readBootstrapEnv(agentSlug)
  if (!env) {
    return c.json({ error: 'No bootstrap env available' }, 404)
  }
  return c.json({ env })
})

export default agentBootstrap

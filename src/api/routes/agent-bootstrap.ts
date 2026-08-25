// Container-to-host endpoint a remote agent VM hits once at boot to fetch its full
// env. Auth: Bearer PROXY_TOKEN whose resolved slug must match :agentSlug.

import { Hono } from 'hono'
import { z } from 'zod'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { readBootstrapEnv } from '@shared/lib/container/agent-bootstrap-env-store'
import { messagePersister } from '@shared/lib/container/message-persister'

const agentBootstrap = new Hono()
const DASHBOARD_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const DashboardScreenshotReadySchema = z.object({
  dashboardSlug: z.string().regex(DASHBOARD_SLUG_REGEX),
})
const DashboardStatusChangedSchema = z.object({
  dashboardSlug: z.string().regex(DASHBOARD_SLUG_REGEX),
  // Terminal startup transitions only — intermediate states stay poll-only.
  status: z.enum(['running', 'crashed']),
})

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

// Container dashboard screenshots are written into the bind-mounted workspace
// after boot. Push that precise transition to renderer caches so Home does not
// poll the full agent list at 5/15/30-second guesses.
agentBootstrap.post('/:agentSlug/events/dashboard-screenshot-ready', async (c) => {
  const agentSlug = c.req.param('agentSlug')
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const callerSlug = await validateProxyToken(token)
  if (!callerSlug) return c.json({ error: 'Unauthorized' }, 401)
  if (callerSlug !== agentSlug) return c.json({ error: 'Token does not match agent' }, 403)

  const parsed = DashboardScreenshotReadySchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid dashboard screenshot event' }, 400)

  messagePersister.broadcastGlobal({
    type: 'dashboard_screenshot_ready',
    agentSlug,
    dashboardSlug: parsed.data.dashboardSlug,
  })
  return c.body(null, 204)
})

// Dashboard startup outcomes ('running' | 'crashed') pushed by the container's
// dashboard manager, so the renderer flips the moment a dashboard is serveable
// instead of waiting out its artifacts-poll interval.
agentBootstrap.post('/:agentSlug/events/dashboard-status-changed', async (c) => {
  const agentSlug = c.req.param('agentSlug')
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const callerSlug = await validateProxyToken(token)
  if (!callerSlug) return c.json({ error: 'Unauthorized' }, 401)
  if (callerSlug !== agentSlug) return c.json({ error: 'Token does not match agent' }, 403)

  const parsed = DashboardStatusChangedSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid dashboard status event' }, 400)

  messagePersister.broadcastGlobal({
    type: 'dashboard_status_changed',
    agentSlug,
    dashboardSlug: parsed.data.dashboardSlug,
    status: parsed.data.status,
  })
  return c.body(null, 204)
})

export default agentBootstrap

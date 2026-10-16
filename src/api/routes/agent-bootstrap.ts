// Container-to-host endpoint a remote agent VM hits once at boot to fetch its full
// env. Auth: Bearer PROXY_TOKEN whose resolved slug must match :agentSlug.

import { Hono } from 'hono'
import { z } from 'zod'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { readBootstrapEnv } from '@shared/lib/container/agent-bootstrap-env-store'
import { messagePersister } from '@shared/lib/container/message-persister'
import { widgetSnapshotReadyEventSchema } from '@shared/lib/widgets/widget-schema'
import { captureException } from '@shared/lib/error-reporting'
import { getSettings } from '@shared/lib/config/settings'

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
// Capped: any container holding a valid token controls this body.
const UndeliveredTurnSchema = z.object({
  sessionId: z.string().min(1).max(200),
  resultSubtype: z.string().max(64).optional(),
  closeCode: z.number().int(),
  closeReason: z.string().max(500),
  msSinceClose: z.number().int().nonnegative(),
  // Optional: the agent image can be older than the app.
  closedAt: z.string().max(64).optional(),
  socketAgeMs: z.number().int().nonnegative().optional(),
  idleMsBeforeClose: z.number().int().nonnegative().optional(),
  socketError: z.string().max(200).optional(),
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

// A widget refresh finished inside the container (host-requested or agent-
// initiated via refresh_widget) and snapshot.json was rewritten. Open Home
// surfaces reload the snapshot; the iframe URL keys on htmlHash.
agentBootstrap.post('/:agentSlug/events/widget-snapshot-ready', async (c) => {
  const agentSlug = c.req.param('agentSlug')
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const callerSlug = await validateProxyToken(token)
  if (!callerSlug) return c.json({ error: 'Unauthorized' }, 401)
  if (callerSlug !== agentSlug) return c.json({ error: 'Token does not match agent' }, 403)

  const parsed = widgetSnapshotReadyEventSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid widget snapshot event' }, 400)

  messagePersister.broadcastGlobal({
    type: 'widget_snapshot_ready',
    agentSlug,
    ...parsed.data,
  })
  return c.body(null, 204)
})

// A turn ended after the session's stream socket dropped on the container
// side. The host's end may still read as open, so this is the only way the
// stuck "working" session (SUP-991) reaches Sentry.
agentBootstrap.post('/:agentSlug/events/undelivered-turn', async (c) => {
  const agentSlug = c.req.param('agentSlug')
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const callerSlug = await validateProxyToken(token)
  if (!callerSlug) return c.json({ error: 'Unauthorized' }, 401)
  if (callerSlug !== agentSlug) return c.json({ error: 'Token does not match agent' }, 403)

  const parsed = UndeliveredTurnSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid undelivered turn event' }, 400)

  const { closeCode, ...report } = parsed.data
  const containerRunner = getSettings().container?.containerRunner ?? 'unknown'
  // Only a host that still shows the turn as working on a socket it thinks is
  // open is stuck; anything else already settled or detached on purpose.
  const hostStuck = messagePersister.isSessionActive(agentSlug, report.sessionId) &&
    messagePersister.isSubscribed(agentSlug, report.sessionId)
  console.warn(
    `[AgentBootstrap] Session ${report.sessionId} (${agentSlug}) ended a turn with no stream subscriber ` +
    `(runner=${containerRunner}, closeCode=${closeCode}, hostStuck=${hostStuck})`,
  )
  if (!hostStuck) return c.body(null, 204)

  captureException(new Error('Session turn ended after its stream socket dropped'), {
    tags: { component: 'container', operation: 'undelivered-turn', containerRunner, closeCode: String(closeCode) },
    extra: { agentId: agentSlug, ...report },
  })
  return c.body(null, 204)
})

export default agentBootstrap

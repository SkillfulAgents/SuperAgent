import { Hono } from 'hono'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { isAuthMode } from '@shared/lib/auth/mode'
import {
  DEFAULT_ACTIVITY_DAYS,
  MAX_ACTIVITY_DAYS,
  MIN_ACTIVITY_DAYS,
} from '@shared/lib/types/activity'
import {
  getAgentActivityStats,
  getConnectionActivityStats,
} from '@shared/lib/services/activity-stats-service'
import { messagePersister } from '@shared/lib/container/message-persister'
import {
  AgentRead,
  Authenticated,
  ResolveAgent,
  getAgentId,
} from '../middleware/auth'

const activityRouter = new Hono()

activityRouter.use('*', Authenticated())

function parseDays(raw: string | undefined): number {
  if (!raw) return DEFAULT_ACTIVITY_DAYS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_ACTIVITY_DAYS
  return Math.min(MAX_ACTIVITY_DAYS, Math.max(MIN_ACTIVITY_DAYS, parsed))
}

// Viewer's Date.prototype.getTimezoneOffset(): real-world values span
// UTC+14 (-840) to UTC-12 (+720); anything outside is a bogus client.
function parseTzOffset(raw: string | undefined): number {
  if (!raw) return 0
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return 0
  return Math.min(840, Math.max(-840, parsed))
}

// Execution liveness, not subscription: subscriptions outlive idle, Stop, and
// some connection-loss paths, but isSessionActive is true only while a turn is
// actually processing — a persisted 'running' with an inactive session is a
// dead or stopped run and must downgrade to failed instead of pulsing forever.
const isSessionLive = (sessionId: string) => messagePersister.isSessionActive(sessionId)

activityRouter.get('/agents/:id', ResolveAgent(), AgentRead(), async (c) => {
  try {
    const days = parseDays(c.req.query('days'))
    const tzOffsetMinutes = parseTzOffset(c.req.query('tz'))
    return c.json(await getAgentActivityStats(getAgentId(c), { days, tzOffsetMinutes, isSessionLive }))
  } catch (error) {
    console.error('Failed to fetch agent activity statistics:', error)
    return c.json({ error: 'Failed to fetch activity statistics' }, 500)
  }
})

activityRouter.get('/connections', async (c) => {
  try {
    const days = parseDays(c.req.query('days'))
    const tzOffsetMinutes = parseTzOffset(c.req.query('tz'))
    const ownerId = isAuthMode() ? getCurrentUserId(c) : undefined
    return c.json(await getConnectionActivityStats({ days, tzOffsetMinutes, ownerId }))
  } catch (error) {
    console.error('Failed to fetch connection activity statistics:', error)
    return c.json({ error: 'Failed to fetch activity statistics' }, 500)
  }
})

export default activityRouter

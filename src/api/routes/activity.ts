import { Hono } from 'hono'
import { getViewerUserId } from '@shared/lib/auth/ownership'
import {
  getAgentActivityStats,
  getConnectionActivityStats,
} from '@shared/lib/services/activity-stats-service'
import { messagePersister } from '@shared/lib/container/message-persister'
import { parseActivityDays, parseActivityTzOffset } from './activity-query'
import {
  AgentRead,
  Authenticated,
  ResolveAgent,
  getAgentId,
} from '../middleware/auth'

const activityRouter = new Hono()

activityRouter.use('*', Authenticated())

// Execution liveness, not subscription: subscriptions outlive idle, Stop, and
// some connection-loss paths, but isSessionActive is true only while a turn is
// actually processing — a persisted 'running' with an inactive session is a
// dead or stopped run and must downgrade to failed instead of pulsing forever.
const isSessionLive = (sessionId: string) => messagePersister.isSessionActive(sessionId)

activityRouter.get('/agents/:id', ResolveAgent(), AgentRead(), async (c) => {
  try {
    const days = parseActivityDays(c.req.query('days'))
    const tzOffsetMinutes = parseActivityTzOffset(c.req.query('tz'))
    const ownerId = getViewerUserId(c) ?? undefined
    return c.json(await getAgentActivityStats(getAgentId(c), {
      days,
      tzOffsetMinutes,
      isSessionLive,
      ownerId,
    }))
  } catch (error) {
    console.error('Failed to fetch agent activity statistics:', error)
    return c.json({ error: 'Failed to fetch activity statistics' }, 500)
  }
})

activityRouter.get('/connections', async (c) => {
  try {
    const days = parseActivityDays(c.req.query('days'))
    const tzOffsetMinutes = parseActivityTzOffset(c.req.query('tz'))
    const ownerId = getViewerUserId(c) ?? undefined
    return c.json(await getConnectionActivityStats({ days, tzOffsetMinutes, ownerId }))
  } catch (error) {
    console.error('Failed to fetch connection activity statistics:', error)
    return c.json({ error: 'Failed to fetch activity statistics' }, 500)
  }
})

export default activityRouter

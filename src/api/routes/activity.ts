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

activityRouter.get('/agents/:id', ResolveAgent(), AgentRead(), async (c) => {
  try {
    const days = parseDays(c.req.query('days'))
    return c.json(await getAgentActivityStats(getAgentId(c), { days }))
  } catch (error) {
    console.error('Failed to fetch agent activity statistics:', error)
    return c.json({ error: 'Failed to fetch activity statistics' }, 500)
  }
})

activityRouter.get('/connections', async (c) => {
  try {
    const days = parseDays(c.req.query('days'))
    const ownerId = isAuthMode() ? getCurrentUserId(c) : undefined
    return c.json(await getConnectionActivityStats({ days, ownerId }))
  } catch (error) {
    console.error('Failed to fetch connection activity statistics:', error)
    return c.json({ error: 'Failed to fetch activity statistics' }, 500)
  }
})

export default activityRouter

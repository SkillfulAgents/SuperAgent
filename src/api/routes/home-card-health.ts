import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { messagePersister } from '@shared/lib/container/message-persister'
import { buildHomeCardHealth } from '@shared/lib/services/home-card-health-service'
import { parseActivityDays, parseActivityTzOffset } from './activity-query'
import { getHomeAgentScope } from './home-agent-scope'

const homeCardHealth = new Hono()

homeCardHealth.use('*', Authenticated())

// GET /api/home-card-health - compact automation descriptors and chart series
// for Card view. Graph topology is deliberately owned by /api/home-graph.
homeCardHealth.get('/', async (c) => {
  try {
    const { agentSlugs } = await getHomeAgentScope(c)
    return c.json(await buildHomeCardHealth({
      agentSlugs,
      days: parseActivityDays(c.req.query('days')),
      tzOffsetMinutes: parseActivityTzOffset(c.req.query('tz')),
      isSessionLive: (sessionId) => messagePersister.isSessionActive(sessionId),
    }))
  } catch (error) {
    console.error('Failed to build home card health:', error)
    return c.json({ error: 'Failed to build home card health' }, 500)
  }
})

export default homeCardHealth

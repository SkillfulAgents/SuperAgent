import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { buildHomeGraph } from '@shared/lib/services/home-graph-service'
import { chatIntegrationManager } from '@shared/lib/chat-integrations/chat-integration-manager'
import { getHomeAgentScope } from './home-agent-scope'

const homeGraph = new Hono()

homeGraph.use('*', Authenticated())

// GET /api/home-graph - Topology snapshot for the home connections graph:
// links, triggers, permissions, and usage weights in one request. Agents,
// accounts, and MCPs come from their own (live) endpoints; see
// home-graph-schema.ts for the wire shape.
homeGraph.get('/', async (c) => {
  try {
    const { agentSlugs, userId } = await getHomeAgentScope(c)

    const graph = await buildHomeGraph({
      agentSlugs,
      userId,
      isIntegrationConnected: (id) => chatIntegrationManager.isIntegrationConnected(id),
    })
    return c.json(graph)
  } catch (error) {
    console.error('Failed to build home graph:', error)
    return c.json({ error: 'Failed to build home graph' }, 500)
  }
})

export default homeGraph

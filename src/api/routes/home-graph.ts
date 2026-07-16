import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { Authenticated } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { listAgents } from '@shared/lib/services/agent-service'
import { buildHomeGraph } from '@shared/lib/services/home-graph-service'
import { chatIntegrationManager } from '@shared/lib/chat-integrations/chat-integration-manager'

const homeGraph = new Hono()

homeGraph.use('*', Authenticated())

// GET /api/home-graph - Topology snapshot for the home connections graph:
// links, triggers, permissions, and usage weights in one request. Agents,
// accounts, and MCPs come from their own (live) endpoints; see
// home-graph-schema.ts for the wire shape.
homeGraph.get('/', async (c) => {
  try {
    // Same visibility rule as GET /api/agents: in auth mode only agents the
    // user has explicit ACL entries for (admins get no implicit listing).
    let agentSlugs: string[]
    let userId: string | null = null
    if (isAuthMode()) {
      userId = getCurrentUserId(c)
      const rows = await db
        .select({ agentSlug: agentAcl.agentSlug })
        .from(agentAcl)
        .where(eq(agentAcl.userId, userId))
      agentSlugs = rows.map((r) => r.agentSlug)
    } else {
      agentSlugs = (await listAgents()).map((a) => a.slug)
    }

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

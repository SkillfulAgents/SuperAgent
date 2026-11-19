import { Hono } from 'hono'
import { z } from 'zod'
import { requireAgentCaller, type AgentCallerVariables } from '../middleware/agent-caller'
import { agentConnectionCatalog } from '@shared/lib/connection-catalog/agent-catalog'
import { connectionCategoryIndex, searchConnectionCatalog } from '@shared/lib/connection-catalog/catalog'
import { captureException } from '@shared/lib/error-reporting'

const searchBodySchema = z.object({ search: z.string().optional() })

const router = new Hono<{ Variables: AgentCallerVariables }>()
router.use('*', requireAgentCaller)

// POST /search — the services matching a term, every way in to each; no term, a category index
router.post('/search', async c => {
  const parsed = searchBodySchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'search must be a string' }, 400)
  try {
    const services = await agentConnectionCatalog(c.get('callerSlug'))
    const search = parsed.data.search?.trim()
    return c.json(search
      ? { total: services.length, services: searchConnectionCatalog(services, search) }
      : { total: services.length, index: connectionCategoryIndex(services) })
  } catch (error) {
    captureException(error, { tags: { component: 'connection-catalog', operation: 'search' } })
    return c.json({ error: 'Failed to search connection options' }, 500)
  }
})

export default router

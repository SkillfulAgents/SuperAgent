import { Hono } from 'hono'
import { requireAgentCaller, type AgentCallerVariables } from '../middleware/agent-caller'
import { listAgentIntegrationInventory } from '@shared/lib/agent-integrations/inventory'
import { captureException } from '@shared/lib/error-reporting'

const router = new Hono<{ Variables: AgentCallerVariables }>()
router.use('*', requireAgentCaller)
router.post('/list', async c => {
  try { return c.json({ integrations: await listAgentIntegrationInventory(c.get('callerSlug')) }) }
  catch (error) {
    captureException(error, { tags: { component: 'agent-integration', operation: 'inventory' } })
    return c.json({ error: 'Failed to list agent integrations' }, 500)
  }
})
export default router

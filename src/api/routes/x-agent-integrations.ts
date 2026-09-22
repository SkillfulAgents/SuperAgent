import { Hono } from 'hono'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { listAgentIntegrationInventory } from '@shared/lib/agent-integrations/inventory'
import { captureException } from '@shared/lib/error-reporting'

const router = new Hono()
router.post('/list', async c => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  const caller = token ? await validateProxyToken(token) : null
  if (!caller) return c.json({ error: 'Unauthorized' }, 401)
  try { return c.json({ integrations: await listAgentIntegrationInventory(caller) }) }
  catch (error) {
    captureException(error, { tags: { component: 'agent-integration', operation: 'inventory' } })
    return c.json({ error: 'Failed to list agent integrations' }, 500)
  }
})
export default router

import { Hono } from 'hono'
import { z } from 'zod'
import { Authenticated, AgentAdmin, AgentRead, EntityAgentRole, ResolveAgent, getAgentId } from '../middleware/auth'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { getChatIntegration, listChatIntegrations } from '@shared/lib/services/chat-integration-service'
import { listChatIntegrationSessions } from '@shared/lib/services/chat-integration-session-service'
import { agentIntegrationManager } from '@shared/lib/agent-integrations/agent-integration-manager'
import { authorizeLinearSetup, completeLinearSetup, createLinearSetup, deleteLinearSetup, publicLinearIntegration } from '@shared/lib/task-manager-integrations/linear/setup'
import { updateLinearConfig } from '@shared/lib/task-manager-integrations/linear/store'
import { captureException } from '@shared/lib/error-reporting'

const router = new Hono()
// Linear redirects a browser without Gamut auth cookies. A random, expiring,
// one-use state binds this callback to an owner-authorized setup on this host.
router.get('/linear/callback', async c => {
  const state = c.req.query('state')
  const code = c.req.query('code')
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  if (!state || !code) return c.html('<h1>Authorization cancelled</h1><p>Return to Gamut to try again.</p>', 400)
  try {
    const id = await completeLinearSetup(state, code)
    await agentIntegrationManager.addIntegration(id)
    return c.html('<h1>Linear connected</h1><p>You can close this window and return to Gamut.</p>')
  } catch (error) {
    captureException(error, { tags: { component: 'linear-setup', operation: 'callback' } })
    return c.html('<h1>Could not connect Linear</h1><p>Return to Gamut and try again. Use a separate private app for each agent, and approve all required permissions.</p>', 400)
  }
})
router.use('*', Authenticated())
const IntegrationRole = EntityAgentRole({ paramName: 'integrationId', contextKey: 'agentIntegration', entityName: 'Agent integration',
  lookupFn: async id => { const row = getChatIntegration(id); return row?.provider === 'linear' ? row : null } })
router.get('/agents/:id', ResolveAgent(), AgentRead(), c => c.json(listChatIntegrations(getAgentId(c)).filter(row => row.provider === 'linear').map(row => ({
  ...publicLinearIntegration(row.id), connected: agentIntegrationManager.getConnector(row.id)?.isConnected() ?? false,
}))))
router.post('/agents/:id/linear', ResolveAgent(), AgentAdmin(), async c => {
  const body = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(await c.req.json())
  return c.json(await createLinearSetup(getAgentId(c), body.name, getCurrentUserId(c), new URL(c.req.url).origin), 201)
})
router.post('/:integrationId/authorize', IntegrationRole('owner'), async c => {
  const id = c.req.param('integrationId')
  await agentIntegrationManager.pauseIntegration(id)
  return c.json({ url: await authorizeLinearSetup(id, await c.req.json()) })
})
router.patch('/:integrationId', IntegrationRole('owner'), async c => {
  const body = z.object({ status: z.enum(['active', 'paused']).optional(), runOnStatusChange: z.boolean().optional() }).strict().parse(await c.req.json())
  const id = c.req.param('integrationId')
  if (body.runOnStatusChange !== undefined) updateLinearConfig(id, latest => ({ ...latest, runOnStatusChange: body.runOnStatusChange! }))
  if (body.status === 'paused') await agentIntegrationManager.pauseIntegration(id)
  if (body.status === 'active') await agentIntegrationManager.resumeIntegration(id)
  return c.json(publicLinearIntegration(id))
})
router.get('/:integrationId/sessions', IntegrationRole('viewer'), c => c.json(listChatIntegrationSessions(c.req.param('integrationId'))))
router.delete('/:integrationId', IntegrationRole('owner'), async c => {
  const id = c.req.param('integrationId')
  await agentIntegrationManager.pauseIntegration(id)
  await deleteLinearSetup(id)
  return c.body(null, 204)
})
router.onError((error, c) => {
  if (error instanceof z.ZodError) return c.json({ error: 'Check the supplied integration settings' }, 400)
  captureException(error, { tags: { component: 'linear-setup', operation: 'route' } })
  return c.json({ error: error.message || 'Linear setup failed' }, 400)
})
export default router

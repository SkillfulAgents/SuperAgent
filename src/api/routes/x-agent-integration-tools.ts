import { Hono } from 'hono'
import { z } from 'zod'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { getIntegration, getIntegrationSessionBySessionId } from '@shared/lib/agent-integrations/store'
import { agentIntegrationManager } from '@shared/lib/agent-integrations/agent-integration-manager'
import { captureException } from '@shared/lib/error-reporting'

const router = new Hono<{ Variables: { agentSlug: string } }>()
router.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '')
  const agentSlug = token ? await validateProxyToken(token) : null
  if (!agentSlug) return c.json({ error: 'Unauthorized' }, 401)
  c.set('agentSlug', agentSlug)
  await next()
})
const inputSchema = z.object({ sessionId: z.string().min(1), name: z.string().optional(), input: z.unknown().optional() }).strict()
for (const op of ['list', 'execute'] as const) {
  router.post(`/${op}`, async c => {
    const parsed = inputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'Invalid integration tool request' }, 400)
    const body = parsed.data
    const agentSlug = c.get('agentSlug')
    try {
      // The SDK may invoke its first tool before createSession returns its ID to
      // the host. Wait for that mapping; never guess an issue or act unbound.
      let mapping = getIntegrationSessionBySessionId(agentSlug, body.sessionId)
      for (let attempt = 0; !mapping && attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250))
        mapping = getIntegrationSessionBySessionId(agentSlug, body.sessionId)
      }
      if (!mapping || mapping.archivedAt) return c.json(op === 'list' ? { tools: [] } : { error: 'No integration is bound to this session' }, op === 'list' ? 200 : 403)
      const integration = getIntegration(mapping.integrationId)
      if (!integration || integration.agentSlug !== agentSlug) return c.json({ error: 'Integration is not active' }, 403)
      const connector = agentIntegrationManager.getConnector(integration.id)
      if (!connector?.isConnected()) return c.json({ error: 'Integration is not connected' }, 409)
      const context = { integration, externalId: mapping.externalId, sessionId: body.sessionId }
      if (!connector.isAllowed(context)) return c.json({ error: 'Integration access denied' }, 403)
      let tools = connector.getTools(context)
      for (let attempt = 0; !tools.length && attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250))
        tools = connector.getTools(context)
      }
      if (op === 'list') return c.json({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      const tool = tools.find(tool => tool.name === body.name)
      if (!tool) return c.json({ error: 'Tool is unavailable in this session' }, 403)
      return c.json({ result: await tool.execute(body.input ?? {}) })
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: 'Tool arguments did not match the tool schema' }, 400)
      captureException(error, { tags: { component: 'integration-tools', operation: op } })
      return c.json({ error: error instanceof Error ? error.message : 'Integration tool failed' }, 400)
    }
  })
}
export default router

import { readConnectionUsage } from '@shared/lib/llm-provider/connection-usage'
import { runWithOptionalUser } from '@shared/lib/platform-attribution/request-context'
import { startOAuthLogin, pollOAuthLogin } from '@shared/lib/llm-provider/oauth-login'
import { Hono } from 'hono'
import { z } from 'zod'
import { Authenticated, IsAdmin } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { getSettings } from '@shared/lib/config/settings'
import {
  canSelectConnection,
  isHelperSelection,
  listConnections,
  resolveSummarizerSelection,
  resolveGlobalSelection,
  saveConnection,
  deleteConnection,
  setGlobalSelection,
  getConnection,
  assertManageConnection,
  providerForConnection,
  prepareConnection,
  type ConnectionViewer,
} from '@shared/lib/llm-provider/connections'
import { BedrockLlmProvider } from '@shared/lib/llm-provider/bedrock-provider'

const routes = new Hono()
routes.use('*', Authenticated())
function viewer(c: Parameters<typeof getCurrentUserId>[0]): ConnectionViewer {
  const user = c.get('user' as never) as { role?: string } | undefined
  return {
    userId: isAuthMode() ? getCurrentUserId(c) : null,
    admin: !isAuthMode() || user?.role === 'admin',
  }
}
routes.onError((error, c) =>
  c.json(
    { error: error instanceof z.ZodError ? 'Invalid connection configuration' : error.message },
    400
  )
)
routes.post('/oauth/:provider/start', async c => {
  const provider = z.enum(['grok', 'codex']).parse(c.req.param('provider'))
  const providerId = provider === 'codex' ? 'codex-subscription' : 'grok-subscription'
  const input = z.object({ id: z.string().optional(), userId: z.string().nullable() }).parse(await c.req.json())
  const actor = viewer(c)
  if (input.id) {
    const row = await getConnection(input.id)
    if (!row || row.provider !== providerId || row.userId !== input.userId) throw new Error('Connection not found')
    assertManageConnection(row, actor)
  }
  if (input.userId === null ? !actor.admin : input.userId !== actor.userId) throw new Error('Cannot manage this connection')
  c.header('Cache-Control', 'no-store')
  return c.json(await startOAuthLogin(actor, input.userId, input.id, providerId))
})
routes.post('/oauth/:id/poll', async c => {
  c.header('Cache-Control', 'no-store')
  return c.json(await pollOAuthLogin(c.req.param('id'), viewer(c)))
})
routes.get('/', async (c) => {
  const connections = await listConnections(viewer(c))
  const root = await resolveGlobalSelection()
  const summarizer = await resolveSummarizerSelection()
  return c.json({
    connections,
    legacyLlmProviderId: getSettings().llmLegacyProviderId,
    defaultSelection: root ? { llmProviderId: root.llmProviderId, model: root.model } : null,
    summarizerSelection:
      isHelperSelection(summarizer)
        ? { llmProviderId: summarizer.llmProviderId, model: summarizer.model }
        : null,
  })
})
routes.post('/', async (c) =>
  c.json({ id: await saveConnection(await c.req.json(), viewer(c)) }, 201)
)
routes.put('/:id', async (c) =>
  c.json({ id: await saveConnection(await c.req.json(), viewer(c), c.req.param('id')) })
)
routes.delete('/:id', async (c) => {
  await deleteConnection(c.req.param('id'), viewer(c))
  return c.json({ success: true })
})
routes.put('/defaults/:purpose', IsAdmin(), async (c) => {
  const purpose = z.enum(['default', 'summarizer']).parse(c.req.param('purpose'))
  await setGlobalSelection(purpose, await c.req.json())
  return c.json({ success: true })
})
routes.post('/validate', async (c) => {
  const body = z
    .object({ id: z.string().optional(), connection: z.unknown() })
    .parse(await c.req.json())
  const { input, config } = await prepareConnection(body.connection, viewer(c), body.id)
  const provider = providerForConnection({
    id: body.id,
    provider: input.provider,
    config: JSON.stringify(config),
  })
  if (provider instanceof BedrockLlmProvider && !provider.getEffectiveApiKey()) {
    const env = await provider.getContainerEnvVars()
    return c.json(
      await provider.validateAwsCredentials(
        env.AWS_ACCESS_KEY_ID ?? '',
        env.AWS_SECRET_ACCESS_KEY ?? '',
        env.AWS_REGION ?? 'us-east-1'
      )
    )
  }
  return c.json(
    await provider.validateKey(provider.getEffectiveApiKey() ?? '', {
      baseUrl: config.apiKeys.genericBaseUrl,
    })
  )
})
routes.get('/:id/usage', async c => {
  c.header('Cache-Control', 'no-store')
  const row = await getConnection(c.req.param('id'))
  const actor = viewer(c)
  // Being able to use another member's saved session does not expose their billing.
  if (!row || !canSelectConnection(row, actor)) return c.json({ error: 'Connection not found' }, 404)
  return c.json(await runWithOptionalUser(actor.userId, () => readConnectionUsage(row)))
})
routes.get('/:id/models/search', async (c) => {
  const row = await getConnection(c.req.param('id'))
  if (!row) return c.json({ error: 'Connection not found' }, 404)
  assertManageConnection(row, viewer(c))
  return c.json({ data: await providerForConnection(row).searchModels(c.req.query('q') ?? '') })
})
export default routes

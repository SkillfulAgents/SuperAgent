import { Hono } from 'hono'
import { z } from 'zod'
import { Authenticated, IsAdmin } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { getSettings } from '@shared/lib/config/settings'
import {
  listConnections,
  resolveConnectionSelection,
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
routes.get('/', async (c) => {
  const connections = await listConnections(viewer(c))
  const summarizer = await resolveConnectionSelection(getSettings().llmSummarizer)
  return c.json({
    connections,
    legacyConnectionId: getSettings().llmLegacyConnectionId,
    defaultSelection: getSettings().llmDefault ?? null,
    summarizerSelection:
      summarizer?.connection.userId === null
        ? { connectionId: summarizer.connectionId, model: summarizer.model }
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
routes.get('/:id/models/search', async (c) => {
  const row = await getConnection(c.req.param('id'))
  if (!row) return c.json({ error: 'Connection not found' }, 404)
  assertManageConnection(row, viewer(c))
  return c.json({ data: await providerForConnection(row).searchModels(c.req.query('q') ?? '') })
})
export default routes

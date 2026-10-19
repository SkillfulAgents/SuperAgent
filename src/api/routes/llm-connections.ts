import { readConnectionUsage } from '@shared/lib/llm-provider/connection-usage'
import { resolveConnectionCredential } from '@shared/lib/llm-provider/connection-credentials'
import { runWithOptionalUser } from '@shared/lib/platform-attribution/request-context'
import { startOAuthLogin, pollOAuthLogin } from '@shared/lib/llm-provider/oauth-login'
import { isOAuthProvider, OAUTH_PROVIDER_IDS } from '@shared/lib/llm-provider/provider-types'
import { Hono } from 'hono'
import { z } from 'zod'
import { Authenticated, IsAdmin } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { getSettings } from '@shared/lib/config/settings'
import {
  canSelectConnection,
  listConnections,
  saveConnection,
  deleteConnection,
  setGlobalSelection,
  compareAndSetGlobalDefault,
  globalSelectionState,
  getConnection,
  assertManageConnection,
  providerForConnection,
  connectionCatalog,
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
  const providerId = z.enum(OAUTH_PROVIDER_IDS).parse(`${c.req.param('provider')}-subscription`)
  const input = z.object({ id: z.string().optional(), userId: z.string().nullable(), region: z.string().optional() }).parse(await c.req.json())
  const actor = viewer(c)
  if (input.id) {
    const row = await getConnection(input.id)
    if (!row || row.provider !== providerId || row.userId !== input.userId) throw new Error('Connection not found')
    assertManageConnection(row, actor)
  }
  if (input.userId === null ? !actor.admin : input.userId !== actor.userId) throw new Error('Cannot manage this connection')
  c.header('Cache-Control', 'no-store')
  return c.json(await startOAuthLogin(actor, input.userId, input.id, providerId, { region: input.region }))
})
routes.post('/oauth/:id/poll', async c => {
  c.header('Cache-Control', 'no-store')
  return c.json(await pollOAuthLogin(c.req.param('id'), viewer(c)))
})
routes.get('/', async (c) => {
  const connections = await listConnections(viewer(c))
  return c.json({
    connections,
    legacyLlmProviderId: getSettings().llmLegacyProviderId,
    ...await globalSelectionState(),
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
  const state = await setGlobalSelection(purpose, await c.req.json())
  return c.json({ success: true, ...state })
})
routes.put('/defaults/default/compare-and-set', IsAdmin(), async (c) => {
  const body = z.object({ expected: z.unknown(), restore: z.unknown() }).parse(await c.req.json())
  return c.json({ updated: await compareAndSetGlobalDefault(body.expected, body.restore) })
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
  let row = await getConnection(c.req.param('id'))
  const actor = viewer(c)
  // Being able to use another member's saved session does not expose their billing.
  if (!row || !canSelectConnection(row, actor)) return c.json({ error: 'Connection not found' }, 404)
  if (c.req.query('refreshCredentials') === '1' && isOAuthProvider(row.provider)) {
    await resolveConnectionCredential(row.id)
    // Refresh can rotate both the token and the usage cache generation.
    row = await getConnection(row.id)
    if (!row) return c.json({ error: 'Connection not found' }, 404)
  }
  return c.json(await runWithOptionalUser(actor.userId, () => readConnectionUsage(row)))
})
routes.get('/:id/model-availability', async c => {
  c.header('Cache-Control', 'no-store')
  const row = await getConnection(c.req.param('id'))
  const actor = viewer(c)
  if (!row || !canSelectConnection(row, actor)) return c.json({ error: 'Connection not found' }, 404)
  // `fresh=1` re-reads the provider's source (after an upgrade, or a refusal).
  const fresh = c.req.query('fresh') === '1'
  return c.json(await runWithOptionalUser(actor.userId,
    () => providerForConnection(row).getModelAvailability(connectionCatalog(row), { fresh })))
})
routes.get('/:id/models/search', async (c) => {
  const row = await getConnection(c.req.param('id'))
  if (!row) return c.json({ error: 'Connection not found' }, 404)
  assertManageConnection(row, viewer(c))
  return c.json({ data: await providerForConnection(row).searchModels(c.req.query('q') ?? '') })
})
export default routes

import { Hono } from 'hono'
import { CredentialRefreshError } from '../../../agent-container/src/credential-refresh-error'
import { IsAgent } from '../middleware/auth'
import { resolveConnectionCredential } from '@shared/lib/llm-provider/connection-credentials'
import { MediaRequestError, mediaConnectionId, mediaProvider } from '@shared/lib/subscription-media'
import { captureException } from '@shared/lib/error-reporting'

const routes = new Hono()
routes.use('*', IsAgent())

routes.post('/:provider/image', async (c) => {
  const provider = mediaProvider(c.req.param('provider'))
  if (!provider) return c.json({ error: 'Unknown media provider' }, 404)
  let input: unknown
  try {
    input = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const slug = c.get('agentSlug' as never) as string
  // The agent names a provider, never an account; the host picks the owner's connection.
  const connectionId = await mediaConnectionId(provider, slug)
  if (!connectionId) return c.json({ error: `${provider.name} is not connected. Connect it in Settings → Model Providers.` }, 400)
  c.header('Cache-Control', 'no-store')
  try {
    const images = await provider.generateImage(input, generation => resolveConnectionCredential(connectionId, generation))
    return c.json({ images })
  } catch (error) {
    if (error instanceof MediaRequestError) return c.json({ error: error.message }, error.status)
    if (error instanceof CredentialRefreshError) return c.json({ error: error.message }, error.status)
    captureException(error, { tags: { component: 'subscription-media', provider: provider.id } })
    return c.json({ error: `${provider.name} media generation failed` }, 502)
  }
})

export default routes

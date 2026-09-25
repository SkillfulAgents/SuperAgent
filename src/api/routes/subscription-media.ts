import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { CredentialRefreshError } from '../../../agent-container/src/credential-refresh-error'
import { IsAgent } from '../middleware/auth'
import { resolveConnectionCredential } from '@shared/lib/llm-provider/connection-credentials'
import { MediaRequestError, mediaConnectionId, mediaProvider, type SubscriptionMediaProvider } from '@shared/lib/subscription-media'
import { captureException } from '@shared/lib/error-reporting'

const routes = new Hono()
routes.use('*', IsAgent())

type Credential = (generation?: number) => ReturnType<typeof resolveConnectionCredential>
type Work = (provider: SubscriptionMediaProvider, input: unknown, connectionId: string, credential: Credential) => Promise<Response>

// The agent names a provider, never an account; the host picks the owner's connection.
async function withConnection(c: Context, work: Work): Promise<Response> {
  const provider = mediaProvider(c.req.param('provider') ?? '')
  if (!provider) return c.json({ error: 'Unknown media provider' }, 404)
  let input: unknown
  try {
    input = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const connectionId = await mediaConnectionId(provider, c.get('agentSlug' as never) as string)
  if (!connectionId) return c.json({ error: `${provider.name} is not connected. Connect it in Settings → Model Providers.` }, 400)
  c.header('Cache-Control', 'no-store')
  try {
    return await work(provider, input, connectionId, generation => resolveConnectionCredential(connectionId, generation))
  } catch (error) {
    if (error instanceof MediaRequestError) return c.json({ error: error.message }, error.status)
    if (error instanceof CredentialRefreshError) return c.json({ error: error.message }, error.status)
    captureException(error, { tags: { component: 'subscription-media', provider: provider.id } })
    return c.json({ error: `${provider.name} media generation failed` }, 502)
  }
}

routes.post('/:provider/image', c => withConnection(c, async (provider, input, _connectionId, credential) =>
  c.json({ images: await provider.generateImage(input, credential) })))

// A video job belongs to the account that started it, so its handle carries the connection.
routes.post('/:provider/video', c => withConnection(c, async (provider, input, connectionId, credential) => {
  if (!provider.startVideo) return c.json({ error: `${provider.name} does not support video` }, 404)
  return c.json({ job: `${connectionId}:${await provider.startVideo(input, credential)}` })
}))

const statusSchema = z.object({ job: z.string() })
routes.post('/:provider/video/status', c => withConnection(c, async (provider, input, connectionId, credential) => {
  if (!provider.getVideo) return c.json({ error: `${provider.name} does not support video` }, 404)
  const parsed = statusSchema.safeParse(input)
  const separator = parsed.success ? parsed.data.job.indexOf(':') : -1
  if (!parsed.success || separator < 0) return c.json({ error: 'Invalid video job' }, 400)
  if (parsed.data.job.slice(0, separator) !== connectionId) {
    return c.json({ error: `The ${provider.name} connection changed after this video started. Start the video again.` }, 409)
  }
  return c.json(await provider.getVideo(parsed.data.job.slice(separator + 1), credential))
}))

export default routes

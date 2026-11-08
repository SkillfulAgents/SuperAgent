import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { IsAdmin } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { background } from '@shared/lib/background'
import { syncCatalogsFromStatus } from '@shared/lib/llm-provider/ollama-catalog-sync'
import { getOllamaStatus } from '@shared/lib/llm-provider/ollama-client'
import { cancelOllamaPull, listOllamaPulls, startOllamaPull } from '@shared/lib/llm-provider/ollama-pull'
import { normalizeOllamaBaseUrl, ollamaModelNameSchema } from '@shared/lib/llm-provider/ollama-schema'

/**
 * Keyed by server URL, not connection: the setup panel needs all of this before
 * a connection exists. Mounted under llm-connections, whose routes authenticate.
 * A status probe reaches no further than the Generic provider's validation
 * already does, and tells a non-admin only whether Ollama answered; a pull
 * writes to the server's disk, so it takes an admin (everyone, without auth mode).
 */
const routes = new Hono()
routes.onError((error, c) =>
  c.json({ error: error instanceof z.ZodError ? error.issues[0]?.message ?? 'Invalid request' : error.message }, 400))
const baseUrlBody = z.object({ baseUrl: z.string().optional() })
const pullBody = baseUrlBody.extend({ model: ollamaModelNameSchema })

const isAdmin = (c: Context) => !isAuthMode() || (c.get('user' as never) as { role?: string } | undefined)?.role === 'admin'

routes.post('/status', async (c) => {
  c.header('Cache-Control', 'no-store')
  const baseUrl = normalizeOllamaBaseUrl(baseUrlBody.parse(await c.req.json()).baseUrl)
  const status = await getOllamaStatus(baseUrl)
  // Asking is also how a model pulled in a terminal shows up without waiting for the next pass.
  if (status.state === 'running') background(syncCatalogsFromStatus(baseUrl, status.models), { name: 'ollama.status-sync' })
  // Why an address failed (a timeout, a 404, something else answering) would map the server's network.
  if (status.state !== 'running' && !isAdmin(c)) return c.json({ ...status, error: `Could not reach Ollama at ${baseUrl}` })
  return c.json(status)
})

routes.post('/pulls/list', async (c) => {
  c.header('Cache-Control', 'no-store')
  const baseUrl = normalizeOllamaBaseUrl(baseUrlBody.parse(await c.req.json()).baseUrl)
  return c.json({ data: await listOllamaPulls(baseUrl) })
})
routes.post('/pulls', IsAdmin(), async (c) => {
  const { baseUrl, model } = pullBody.parse(await c.req.json())
  await startOllamaPull(normalizeOllamaBaseUrl(baseUrl), model)
  return c.json({ success: true }, 202)
})
routes.post('/pulls/cancel', IsAdmin(), async (c) => {
  const { baseUrl, model } = pullBody.parse(await c.req.json())
  await cancelOllamaPull(normalizeOllamaBaseUrl(baseUrl), model)
  return c.json({ success: true })
})

export default routes

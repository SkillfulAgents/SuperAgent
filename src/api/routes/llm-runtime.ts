import { Hono } from 'hono'
import { z } from 'zod'
import { IsAgent } from '../middleware/auth'
import { agentRegistry } from '@shared/lib/agent-actor'
import { resolveExecutionSelection, storedSelection } from '@shared/lib/llm-provider/connections'
import {
  connectionRuntime,
  rememberSessionRuntime,
} from '@shared/lib/llm-provider/connection-runtime'

const routes = new Hono()
routes.use('*', IsAgent())
const requestSchema = z.object({
  sessionId: z.string().min(1),
  llmProviderId: z.string().optional(),
})
routes.post('/resolve', async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Invalid credential request' }, 400)
  const input = parsed.data
  const slug = c.get('agentSlug' as never) as string
  const actor = agentRegistry.get(slug)
  if (!(await actor.sessions.isKnown(input.sessionId)))
    return c.json({ error: 'Session not found' }, 404)
  const metadata = await actor.sessions.metadata(input.sessionId)
  const preferences = await actor.config.get('preferences')
  const selected = await resolveExecutionSelection(
    storedSelection(metadata?.model, metadata?.llmProviderId),
    storedSelection(preferences?.defaultModel, preferences?.defaultLlmProviderId)
  )
  // The caller cannot nominate another connection. The app resolves the
  // authenticated agent's current session binding on every callback.
  c.header('Cache-Control', 'no-store')
  if (input.llmProviderId && input.llmProviderId !== selected.llmProviderId)
    return c.json({ error: 'Session connection changed' }, 409)
  const runtime = await connectionRuntime(selected, slug)
  rememberSessionRuntime(slug, input.sessionId, runtime)
  return c.json(runtime)
})
// Boot prewarming is bound to the authenticated agent's default. The container
// cannot use this endpoint to choose an arbitrary personal provider.
routes.post('/prewarm', async (c) => {
  const slug = c.get('agentSlug' as never) as string
  const preferences = await agentRegistry.get(slug).config.get('preferences')
  const selected = await resolveExecutionSelection(
    storedSelection(preferences?.defaultModel, preferences?.defaultLlmProviderId),
  )
  c.header('Cache-Control', 'no-store')
  return c.json(await connectionRuntime(selected, slug))
})
export default routes

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
  connectionId: z.string().optional(),
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
    storedSelection(metadata?.model, metadata?.connectionId),
    storedSelection(preferences?.defaultModel, preferences?.defaultConnectionId)
  )
  // The caller cannot nominate another connection. The app resolves the
  // authenticated agent's current session binding on every callback.
  c.header('Cache-Control', 'no-store')
  if (input.connectionId && input.connectionId !== selected.connectionId)
    return c.json({ error: 'Session connection changed' }, 409)
  const runtime = await connectionRuntime(selected, slug)
  rememberSessionRuntime(slug, input.sessionId, runtime)
  return c.json(runtime)
})
export default routes

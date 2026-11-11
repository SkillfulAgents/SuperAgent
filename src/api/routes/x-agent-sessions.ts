import { Hono } from 'hono'
import { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { deleteSessionAndRecords } from '@shared/lib/services/session-deletion'

/**
 * The agent's own way to its sessions' names: the session-history scripts in
 * its container (`/opt/gamut/bin`) call these routes with the agent's proxy
 * token. What the app keeps about a session is in the agent's session index,
 * which the container cannot read, so this is how an agent sees the names
 * people gave its past sessions, renames one, or deletes one.
 *
 * Every route acts on the caller's own sessions only: the agent is whoever
 * the token says, and nothing in the request can name another.
 */
type Variables = { callerSlug: string }
const xAgentSessions = new Hono<{ Variables: Variables }>()

xAgentSessions.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  const callerSlug = token ? await validateProxyToken(token) : null
  if (!callerSlug) return c.json({ error: 'Unauthorized' }, 401)
  c.set('callerSlug', callerSlug)
  await next()
})

// A name, and nothing else: how a session was started and who started it are
// the app's to say, not the agent's.
const renameSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict()

// GET /api/x-agent/sessions - the names of the caller's sessions, by session id
xAgentSessions.get('/', async (c) => {
  const metadata = await agentRegistry.get(c.get('callerSlug')).sessions.readMetadata()
  const names: Record<string, string> = {}
  for (const [sessionId, { name }] of Object.entries(metadata)) {
    if (typeof name === 'string' && name !== '') names[sessionId] = name
  }
  return c.json({ names })
})

// PATCH /api/x-agent/sessions/:sessionId - rename one of the caller's sessions
xAgentSessions.patch('/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const body = renameSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'Expected { "name": "<1 to 200 characters>" }' }, 400)
  const { sessions } = agentRegistry.get(c.get('callerSlug'))
  // Before renaming: a rename of an unknown id would otherwise register one.
  if (!(await sessions.isKnown(sessionId))) return c.json({ error: 'Session not found' }, 404)
  await sessions.rename(sessionId, body.data.name)
  return c.json({ id: sessionId, name: body.data.name })
})

// DELETE /api/x-agent/sessions/:sessionId - delete one of the caller's sessions
xAgentSessions.delete('/:sessionId', async (c) => {
  const agentSlug = c.get('callerSlug')
  const sessionId = c.req.param('sessionId')
  const { sessions } = agentRegistry.get(agentSlug)
  if (!(await sessions.exists(sessionId)) && !(await sessions.isRegistered(sessionId))) {
    return c.json({ error: 'Session not found' }, 404)
  }
  // The session the caller is running in is one of these, so an agent cannot
  // delete the conversation it is having; nor one a person is waiting in.
  const live = await sessions.live(sessionId)
  if (live.isActive || live.isAwaitingInput) {
    return c.json({ error: 'This session is running or waiting for input and cannot be deleted' }, 409)
  }
  if (!(await deleteSessionAndRecords(agentSlug, sessionId))) return c.json({ error: 'Session not found' }, 404)
  return c.body(null, 204)
})

export default xAgentSessions

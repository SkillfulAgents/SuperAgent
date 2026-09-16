import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { agentRegistry, WorkspaceFileError, MemoryError, MAX_MEMORY_BYTES } from '@shared/lib/agent-actor'
import { AgentAdmin, getAgentId } from '../middleware/auth'

export const agentMemoryRoutes = new Hono()

agentMemoryRoutes.onError((error, c) => {
  if (error instanceof MemoryError || error instanceof WorkspaceFileError) {
    return c.json({ error: error.message }, error.status)
  }
  console.error('Memory operation failed:', error)
  return c.json({ error: 'Unable to access agent memories' }, 500)
})

// Match the private agent-directory and skill editor's admin scope.
agentMemoryRoutes.get('/:id/memories', AgentAdmin(), async c => {
  c.header('Cache-Control', 'no-store')
  return c.json({ memories: await agentRegistry.get(getAgentId(c)).memories.list() })
})

agentMemoryRoutes.get('/:id/memories/content', AgentAdmin(), async c => {
  c.header('Cache-Control', 'no-store')
  return c.json(await agentRegistry.get(getAgentId(c)).memories.read(c.req.query('path') ?? ''))
})

agentMemoryRoutes.put('/:id/memories/content', AgentAdmin(), zValidator('json', z.object({
  path: z.string().min(1),
  content: z.string().max(MAX_MEMORY_BYTES),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
})), async c => {
  const { path, content, revision } = c.req.valid('json')
  return c.json(await agentRegistry.get(getAgentId(c)).memories.save(path, content, revision))
})

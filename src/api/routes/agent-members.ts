import { Hono } from 'hono'
import { AgentRead, getAgentId, getReadableAgentIds } from '../middleware/auth'
import { bodyLimit } from 'hono/body-limit'
import { zValidator } from '@hono/zod-validator'
import { agentMembersBatchRequestSchema, agentMembersBatchResponseSchema } from '@shared/lib/agent-members-schema'
import { agentCatalog } from '@shared/lib/agent-actor'
import { isAuthMode } from '@shared/lib/auth/mode'
import { listAgentMembers, listAgentMembersByAgent } from '@shared/lib/services/agent-members-service'

// Mounted after Authenticated() and ResolveAgent() in the agent router.
const agentMembers = new Hono()
agentMembers.get('/', AgentRead(), async (c) => {
  if (!isAuthMode()) return c.notFound()
  return c.json(await listAgentMembers(getAgentId(c)))
})
export default agentMembers

// Collection route: mounted after Authenticated(), before /:id/* resolution.
export const agentMembersBatch = new Hono().post('/',
  bodyLimit({ maxSize: 32 * 1024 }),
  zValidator('json', agentMembersBatchRequestSchema),
  async (c) => {
    if (!isAuthMode()) return c.notFound()
    const slugs = [...new Set(c.req.valid('json').agentSlugs)]
    const resolved = await Promise.all(slugs.map(async slug => [slug, await agentCatalog.resolve(slug)] as const))
    const ids = [...new Set(resolved.flatMap(([, id]) => id ? [id] : []))]
    const readable = await getReadableAgentIds(c, ids)
    const members = await listAgentMembersByAgent([...readable])
    return c.json(agentMembersBatchResponseSchema.parse(Object.fromEntries(resolved.map(([slug, id]) => [
      slug,
      !id ? { status: 404 } : !readable.has(id) ? { status: 403 } : { status: 200, members: members[id] },
    ]))))
  },
)

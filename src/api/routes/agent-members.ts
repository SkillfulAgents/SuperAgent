import { Hono } from 'hono'
import { AgentRead, AgentUser, canUseAgent, getAgentId, getReadableAgentIds } from '../middleware/auth'
import { bodyLimit } from 'hono/body-limit'
import { zValidator } from '@hono/zod-validator'
import { agentMembersBatchRequestSchema, agentMembersBatchResponseSchema } from '@shared/lib/agent-members-schema'
import { agentCatalog } from '@shared/lib/agent-actor'
import { z } from 'zod'
import { getHomeAgentScope } from './home-agent-scope'
import { getViewerUserId } from '@shared/lib/auth/ownership'
import { changeAgentShare, listAgentShares } from '@shared/lib/services/agent-sharing-service'
import { memberAgentRoleSchema } from '@shared/lib/types/agent-sharing'
import { isAuthMode } from '@shared/lib/auth/mode'
import { listAgentMembers, listAgentMembersByAgent, notifyAgentMembersChanged } from '@shared/lib/services/agent-members-service'

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

// All sidebar stacks share one read. Inherited grants are resolved only for an open roster.
export const agentShareStacks = new Hono().get('/', async c => {
  const { agentSlugs, userId } = await getHomeAgentScope(c)
  const rosters = await listAgentShares(agentSlugs, userId)
  return c.json(Object.fromEntries(Object.entries(rosters).map(([slug, roster]) => [slug, roster.direct])))
})

export const agentShares = new Hono()
  .get('/', AgentRead(), async c => {
    const target = getAgentId(c)
    const rosters = await listAgentShares([target], getViewerUserId(c), true)
    return c.json(rosters[target] ?? { direct: [], global: [] })
  })
  .put('/:caller', AgentUser(), zValidator('json', z.object({ role: z.union([memberAgentRoleSchema, z.literal('remove')]) })), async c => {
    const target = getAgentId(c)
    const caller = c.req.param('caller')
    const role = c.req.valid('json').role
    const roster = await listAgentShares([target], getViewerUserId(c))
    const member = roster[target]?.direct.find(agent => agent.slug === caller)
    if (!member) return c.json({ error: 'Direct share not found' }, 404)
    if (!(await canUseAgent(c, caller))) return c.json({ error: 'User access to both agents is required' }, 403)
    if (role === 'user' && !member.canMessage) return c.json({ error: 'An owner of this agent needs User access to the target' }, 403)
    await changeAgentShare(caller, target, role)
    await notifyAgentMembersChanged(target)
    return c.json({ ok: true })
  })

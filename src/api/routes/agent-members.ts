import { Hono } from 'hono'
import { AgentRead, getAgentId } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { listAgentMembers } from '@shared/lib/services/agent-members-service'

// Mounted after Authenticated() and ResolveAgent() in the agent router.
const agentMembers = new Hono()
agentMembers.get('/', AgentRead(), (c) => {
  if (!isAuthMode()) return c.notFound()
  return c.json(listAgentMembers(getAgentId(c)))
})
export default agentMembers

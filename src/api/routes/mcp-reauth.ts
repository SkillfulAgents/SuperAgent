import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentRemoteMcps, remoteMcpServers } from '@shared/lib/db/schema'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { isOwnedByCaller, ownerScope } from '@shared/lib/auth/ownership'
import { agentRegistry } from '@shared/lib/agent-actor'
import { finishConnectionReplacement } from '@shared/lib/container/connection-replacement'
import { sameMcpEndpoint } from '@shared/lib/mcp/endpoint'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { AgentUser, getAgentId } from '../middleware/auth'

const mcpReauth = new Hono()
const replacementSchema = z.object({ remoteMcpIds: z.array(z.string().min(1)).length(1) })

function loadRequestedMcp(requestId: string, agentSlug: string) {
  // The actor only hands back this agent's requests; another agent's reads as absent.
  const request = agentRegistry.get(agentSlug).inputs.get(requestId)
  if (request?.kind !== 'mcp_reauth_required' || !request.payload.mcpId) return null
  return db.select({ mapping: agentRemoteMcps, mcp: remoteMcpServers })
    .from(agentRemoteMcps).innerJoin(remoteMcpServers, eq(agentRemoteMcps.remoteMcpId, remoteMcpServers.id))
    .where(and(eq(agentRemoteMcps.agentSlug, agentSlug), eq(remoteMcpServers.id, request.payload.mcpId)))
    .get() ?? null
}

// Prefill from the caller's own connection or the public catalog. Never expose
// another owner's custom URL, which may contain credentials in its query string.
mcpReauth.get('/:id/reauth-request/:requestId/replace-mcp', AgentUser(), (c) => {
  const current = loadRequestedMcp(c.req.param('requestId'), getAgentId(c))
  if (!current) return c.json({ error: 'Reconnection request is no longer available' }, 404)
  const ownMcps = db.select().from(remoteMcpServers).where(ownerScope(c, remoteMcpServers.userId)).all()
  const ownMatch = ownMcps.find((mcp) => mcp.id !== current.mcp.id && sameMcpEndpoint(mcp.url, current.mcp.url))
  const catalogMatch = COMMON_MCP_SERVERS.find((mcp) => sameMcpEndpoint(mcp.url, current.mcp.url))
  const url = ownMatch?.url ?? catalogMatch?.url ?? (isOwnedByCaller(c, current.mcp) ? current.mcp.url : '')
  return c.json({ url })
})

mcpReauth.post('/:id/reauth-request/:requestId/replace-mcp', AgentUser(), async (c) => {
  const agentSlug = getAgentId(c)
  const requestId = c.req.param('requestId')
  const parsed = replacementSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Select one replacement MCP connection' }, 400)

  try {
    const result = db.transaction((tx) => {
      const current = loadRequestedMcp(requestId, agentSlug)
      if (!current) return { error: 'Reconnection request is no longer available', status: 404 as const }
      const replacementId = parsed.data.remoteMcpIds[0]
      const replacement = tx.select().from(remoteMcpServers).where(and(
        eq(remoteMcpServers.id, replacementId), ownerScope(c, remoteMcpServers.userId),
      )).get()
      if (!replacement) return { error: 'MCP connection not found', status: 404 as const }
      if (replacementId === current.mcp.id || !sameMcpEndpoint(current.mcp.url, replacement.url)) {
        return { error: 'Choose a different connection to the same MCP endpoint', status: 400 as const }
      }
      if (replacement.status !== 'active') return { error: 'Reconnect the replacement MCP before granting access', status: 409 as const }

      tx.insert(agentRemoteMcps).values({
        id: crypto.randomUUID(), agentSlug, remoteMcpId: replacementId, createdAt: new Date(),
      }).onConflictDoNothing().run()
      tx.delete(agentRemoteMcps).where(eq(agentRemoteMcps.id, current.mapping.id)).run()
      return { previousId: current.mcp.id, replacementId, name: current.mcp.name }
    })
    if ('error' in result) return c.json({ error: result.error }, result.status)

    logAuditEvent({ userId: getCurrentUserId(c), object: 'mcp', objectId: result.previousId, action: 'unassigned', details: { agentSlug } })
    logAuditEvent({ userId: getCurrentUserId(c), object: 'mcp', objectId: result.replacementId, action: 'assigned', details: { agentSlug } })
    const recovery = await finishConnectionReplacement({ agentSlug, kind: 'remote-mcps', ...result }, () => {
      const actor = agentRegistry.get(agentSlug)
      if (!actor.inputs.mcpReauth.replace(requestId, result.replacementId)) {
        actor.inputs.resolve(requestId, 'answered')
        actor.sessions.syncAwaiting()
      }
    })
    return c.json({ success: true, ...recovery })
  } catch (error) {
    console.error('Failed to replace MCP connection:', error)
    return c.json({ error: 'Failed to replace the MCP connection' }, 500)
  }
})

export default mcpReauth

import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch } from '@shared/lib/db/batch'
import { agentConnectedAccounts, connectedAccounts } from '@shared/lib/db/schema'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { ownerScope } from '@shared/lib/auth/ownership'
import { accountReauthManager } from '@shared/lib/proxy/account-reauth-manager'
import { agentRegistry } from '@shared/lib/agent-actor'
import { finishConnectionReplacement } from '@shared/lib/container/connection-replacement'
import { getProvider } from '@shared/lib/account-providers/service-catalog'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { AgentUser, getAgentId } from '../middleware/auth'

const accountReauth = new Hono()
const replacementSchema = z.object({ accountIds: z.array(z.string().min(1)).length(1) })

// Mounted under agents, after authentication and agent resolution. Members can
// supply their own connection, as in provide-connected-account/provide-remote-mcp.
accountReauth.post('/:id/reauth-request/:requestId/replace-account', AgentUser(), async (c) => {
  const slug = getAgentId(c)
  const requestId = c.req.param('requestId')
  const parsed = replacementSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Select one replacement account' }, 400)

  try {
    // The actor only hands back this agent's requests; another agent's reads as absent.
    const request = agentRegistry.get(slug).inputs.get(requestId)
    if (request?.kind !== 'account_reauth_required') {
      return c.json({ error: 'Reconnection request is no longer available' }, 404)
    }
    const previousAccountId = request.payload.accountId
    if (!previousAccountId || !request.payload.toolkit) {
      return c.json({ error: 'Invalid reconnection request' }, 409)
    }
    const accountId = parsed.data.accountIds[0]
    const replacement = await db.select().from(connectedAccounts).where(and(
      eq(connectedAccounts.id, accountId),
      ownerScope(c, connectedAccounts.userId),
    )).get()
    if (!replacement) return c.json({ error: 'Account not found' }, 404)
    if (replacement.toolkitSlug !== request.payload.toolkit || accountId === previousAccountId) {
      return c.json({ error: 'Choose a different account for the same service' }, 400)
    }
    if (replacement.status !== 'active') {
      return c.json({ error: 'Reconnect the replacement account before granting access' }, 409)
    }
    const mapping = await db.select().from(agentConnectedAccounts).where(and(
      eq(agentConnectedAccounts.agentSlug, slug),
      eq(agentConnectedAccounts.connectedAccountId, previousAccountId),
    )).get()
    if (!mapping) return c.json({ error: 'The original account is no longer assigned to this agent' }, 409)

    // One batch: assign the replacement (a no-op if a concurrent grant already
    // did) and drop the original mapping (a no-op if it was unassigned
    // meanwhile). Either way the agent ends up with the replacement and
    // without the original, which is the state the card settles into.
    await batch([
      db.insert(agentConnectedAccounts).values({
        id: crypto.randomUUID(),
        agentSlug: slug,
        connectedAccountId: accountId,
        createdAt: new Date(),
      }).onConflictDoNothing(),
      db.delete(agentConnectedAccounts).where(eq(agentConnectedAccounts.id, mapping.id)),
    ])
    const result = { accountId, previousAccountId, toolkit: request.payload.toolkit }

    logAuditEvent({ userId: getCurrentUserId(c), object: 'account', objectId: result.previousAccountId, action: 'unassigned', details: { agentSlug: slug } })
    logAuditEvent({ userId: getCurrentUserId(c), object: 'account', objectId: result.accountId, action: 'assigned', details: { agentSlug: slug } })
    const recovery = await finishConnectionReplacement({
      agentSlug: slug,
      kind: 'connected-accounts',
      name: getProvider(result.toolkit)?.displayName ?? result.toolkit,
      previousId: result.previousAccountId,
      replacementId: result.accountId,
    }, () => {
      if (!accountReauthManager.replaceAccount(requestId, slug, result.accountId)) {
        const actor = agentRegistry.get(slug)
        actor.inputs.resolve(requestId, 'answered')
        actor.sessions.syncAwaiting()
      }
    })
    return c.json({ success: true, ...recovery })
  } catch (error) {
    console.error('Failed to replace account connection:', error)
    return c.json({ error: 'Failed to replace the connection' }, 500)
  }
})

export default accountReauth

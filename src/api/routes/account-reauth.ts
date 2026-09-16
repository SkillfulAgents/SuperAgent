import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq, exists, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch, changesOf, insertWhere } from '@shared/lib/db/batch'
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
    // The reads above yielded; make sure the card did not settle meanwhile.
    if (agentRegistry.get(slug).inputs.get(requestId)?.kind !== 'account_reauth_required') {
      return c.json({ error: 'Reconnection request is no longer available' }, 404)
    }

    // The write claims the original mapping. The replacement is assigned only
    // while that mapping still exists, and deleting it is what makes this
    // request the winner: a concurrent replacement, unassign or reconnect
    // that consumed it first leaves this batch with zero changes, and the
    // caller gets the same 409 the base code gave the loser.
    const originalStillAssigned = exists(
      db.select({ one: sql`1` }).from(agentConnectedAccounts).where(eq(agentConnectedAccounts.id, mapping.id)),
    )
    const [, unlinked] = await batch([
      insertWhere(agentConnectedAccounts, {
        id: crypto.randomUUID(),
        agentSlug: slug,
        connectedAccountId: accountId,
        createdAt: new Date(),
      }, originalStillAssigned).onConflictDoNothing(),
      db.delete(agentConnectedAccounts).where(eq(agentConnectedAccounts.id, mapping.id)),
    ])
    if (changesOf(unlinked) === 0) {
      return c.json({ error: 'The original account is no longer assigned to this agent' }, 409)
    }
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

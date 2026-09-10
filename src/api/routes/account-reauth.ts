import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentConnectedAccounts, connectedAccounts } from '@shared/lib/db/schema'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { ownerScope } from '@shared/lib/auth/ownership'
import { accountReauthManager } from '@shared/lib/proxy/account-reauth-manager'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
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
    // Keep validation and the mapping swap synchronous and atomic: a timeout,
    // dismissal, or owner reconnect cannot settle the card between them.
    const result = db.transaction((tx) => {
      const request = userInputRequestManager.getOpenRequest(requestId)
      if (request?.kind !== 'account_reauth_required' || request.scope.agentSlug !== slug) {
        return { error: 'Reconnection request is no longer available', status: 404 as const }
      }
      const previousAccountId = request.payload.accountId
      if (!previousAccountId || !request.payload.toolkit) {
        return { error: 'Invalid reconnection request', status: 409 as const }
      }
      const accountId = parsed.data.accountIds[0]
      const replacement = tx.select().from(connectedAccounts).where(and(
        eq(connectedAccounts.id, accountId),
        ownerScope(c, connectedAccounts.userId),
      )).get()
      if (!replacement) return { error: 'Account not found', status: 404 as const }
      if (replacement.toolkitSlug !== request.payload.toolkit || accountId === previousAccountId) {
        return { error: 'Choose a different account for the same service', status: 400 as const }
      }
      if (replacement.status !== 'active') {
        return { error: 'Reconnect the replacement account before granting access', status: 409 as const }
      }
      const mapping = tx.select().from(agentConnectedAccounts).where(and(
        eq(agentConnectedAccounts.agentSlug, slug),
        eq(agentConnectedAccounts.connectedAccountId, previousAccountId),
      )).get()
      if (!mapping) return { error: 'The original account is no longer assigned to this agent', status: 409 as const }

      tx.insert(agentConnectedAccounts).values({
        id: crypto.randomUUID(),
        agentSlug: slug,
        connectedAccountId: accountId,
        createdAt: new Date(),
      }).onConflictDoNothing().run()
      tx.delete(agentConnectedAccounts).where(eq(agentConnectedAccounts.id, mapping.id)).run()
      return { accountId, previousAccountId, toolkit: request.payload.toolkit }
    })
    if ('error' in result) return c.json({ error: result.error }, result.status)

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
        userInputRequestManager.resolve(requestId, 'answered')
        messagePersister.syncAgentSessionsAwaiting(slug)
      }
    })
    return c.json({ success: true, ...recovery })
  } catch (error) {
    console.error('Failed to replace account connection:', error)
    return c.json({ error: 'Failed to replace the connection' }, 500)
  }
})

export default accountReauth

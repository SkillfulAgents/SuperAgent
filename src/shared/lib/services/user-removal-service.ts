/**
 * Removing a user (Settings → Users → Delete, Better Auth's admin remove-user)
 * cascades their connected accounts, MCP servers and agent memberships through
 * the FKs to `user`. A cascade cannot reach outside the database, so the hooks
 * around the delete do what deleting each account or server by hand does:
 *
 * - before: cancel the accounts' webhook triggers and revoke their provider
 *   connections. A connection left live would come back: account sync imports
 *   any active remote connection that has no local row.
 * - after: remove their settings (no FK: the 'local' sentinel has no user row),
 *   audit the proxy rules the cascade took and the removal itself, and refresh
 *   the running agents that had their accounts or servers.
 *
 * Best effort throughout: a failure is logged and never stops the removal.
 */
import { eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { connectedAccounts, remoteMcpServers, userSettings, type ConnectedAccount } from '@shared/lib/db/schema'
import { getAccountProviderByName } from '@shared/lib/account-providers'
import { auditRuleChange, rulesAboutToBeRemoved } from '@shared/lib/proxy/rules/audit-events'
import type { RuleView } from '@shared/lib/proxy/rules/store'
import { logAuditEvent } from './audit-log-service'
import {
  findAgentsAssignedConnectedAccount,
  findAgentsAssignedRemoteMcp,
  syncConnectedAccountAgents,
  syncRemoteMcpAgents,
} from './connection-sync-service'
import { cancelTriggersForConnectedAccount } from './webhook-trigger-service'

interface PendingRemoval {
  accounts: { id: string; toolkitSlug: string }[]
  mcps: { id: string; name: string }[]
  rules: RuleView[]
  accountAgents: string[]
  mcpAgents: string[]
}

/** What `before` read for `after`, by which time the cascade has taken the rows. */
const pending = new Map<string, PendingRemoval>()

export async function beforeUserRemoved(userId: string): Promise<void> {
  pending.delete(userId)
  try {
    const accounts = await db.select().from(connectedAccounts).where(eq(connectedAccounts.userId, userId))
    const mcps = await db.select({ id: remoteMcpServers.id, name: remoteMcpServers.name })
      .from(remoteMcpServers).where(eq(remoteMcpServers.userId, userId))
    await Promise.all(accounts.map(revokeRemotely))
    const [accountRules, mcpRules, accountAgents, mcpAgents] = await Promise.all([
      Promise.all(accounts.map(account => rulesAboutToBeRemoved({ kind: 'api', targetId: account.id }))),
      Promise.all(mcps.map(mcp => rulesAboutToBeRemoved({ kind: 'mcp', targetId: mcp.id }))),
      Promise.all(accounts.map(account => findAgentsAssignedConnectedAccount(account.id))),
      Promise.all(mcps.map(mcp => findAgentsAssignedRemoteMcp(mcp.id))),
    ])
    pending.set(userId, {
      accounts: accounts.map(({ id, toolkitSlug }) => ({ id, toolkitSlug })),
      mcps,
      rules: [...accountRules.flat(), ...mcpRules.flat()],
      accountAgents: [...new Set(accountAgents.flat())],
      mcpAgents: [...new Set(mcpAgents.flat())],
    })
  } catch (error) {
    console.warn(`[user-removal] Failed to prepare the removal of user ${userId}:`, error)
  }
}

/** The account's outside state, through the provider that issued its connection. */
async function revokeRemotely(account: ConnectedAccount): Promise<void> {
  try {
    await cancelTriggersForConnectedAccount(account.id)
  } catch (error) {
    console.warn(`[user-removal] Failed to cancel the webhook triggers of account ${account.id}:`, error)
  }
  try {
    await getAccountProviderByName(account.providerName).deleteConnection(account.providerConnectionId, account.toolkitSlug)
  } catch (error) {
    console.warn(`[user-removal] Failed to revoke the ${account.providerName} connection of account ${account.id}:`, error)
  }
}

export async function afterUserRemoved(removed: { id: string; email: string }, removedBy: string | null): Promise<void> {
  const removal = pending.get(removed.id)
  pending.delete(removed.id)
  try {
    await db.delete(userSettings).where(eq(userSettings.userId, removed.id))
  } catch (error) {
    console.warn(`[user-removal] Failed to delete the settings of user ${removed.id}:`, error)
  }
  for (const rule of removal?.rules ?? []) {
    await auditRuleChange('deleted', rule, { by: 'system', reason: 'user_removed' }, removedBy)
  }
  await logAuditEvent({
    userId: removedBy,
    object: 'user',
    objectId: removed.id,
    action: 'removed',
    details: { email: removed.email, accounts: removal?.accounts ?? [], mcps: removal?.mcps ?? [] },
  })
  try {
    if (removal?.accountAgents.length) await syncConnectedAccountAgents(removal.accountAgents)
    if (removal?.mcpAgents.length) await syncRemoteMcpAgents(removal.mcpAgents)
  } catch (error) {
    console.warn(`[user-removal] Failed to refresh the agents of removed user ${removed.id}:`, error)
  }
}

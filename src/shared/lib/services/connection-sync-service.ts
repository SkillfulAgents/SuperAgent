/**
 * Push connected-account / remote-MCP projections to every agent that a
 * connection is assigned to.
 *
 * The per-agent push is `actor.container.syncConnectionEnvironment(kind)`;
 * this module only answers "which agents" from the mapping tables and fans
 * out. It is an app-level service, so it never touches the container layer
 * directly.
 */
import { db } from '@shared/lib/db'
import { agentConnectedAccounts, agentRemoteMcps } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { agentRegistry } from '@shared/lib/agent-actor'
import type { ConnectionRuntimeKind } from '@shared/lib/container/connection-runtime-sync'

async function syncAgents(agentSlugs: string[], kind: ConnectionRuntimeKind): Promise<boolean> {
  const results = await Promise.all(
    [...new Set(agentSlugs)].map((slug) => agentRegistry.get(slug).container.syncConnectionEnvironment(kind)),
  )
  return results.every(Boolean)
}

export async function findAgentsAssignedRemoteMcp(mcpId: string): Promise<string[]> {
  const mappings = await db
    .select({ agentSlug: agentRemoteMcps.agentSlug })
    .from(agentRemoteMcps)
    .where(eq(agentRemoteMcps.remoteMcpId, mcpId))
  return mappings.map(({ agentSlug }) => agentSlug)
}

export async function findAgentsAssignedConnectedAccount(accountId: string): Promise<string[]> {
  const mappings = await db
    .select({ agentSlug: agentConnectedAccounts.agentSlug })
    .from(agentConnectedAccounts)
    .where(eq(agentConnectedAccounts.connectedAccountId, accountId))
  return mappings.map(({ agentSlug }) => agentSlug)
}

export async function syncRemoteMcpAgents(agentSlugs: string[]): Promise<boolean> {
  return syncAgents(agentSlugs, 'remote-mcps')
}

export async function syncConnectedAccountAgents(agentSlugs: string[]): Promise<boolean> {
  return syncAgents(agentSlugs, 'connected-accounts')
}

export async function syncAgentsAssignedRemoteMcp(mcpId: string): Promise<boolean> {
  try {
    return await syncRemoteMcpAgents(await findAgentsAssignedRemoteMcp(mcpId))
  } catch (error) {
    console.warn(`[ConnectionSync] Failed to resolve agents assigned MCP ${mcpId}:`, error)
    return false
  }
}

export async function syncAgentsAssignedConnectedAccount(accountId: string): Promise<boolean> {
  try {
    return await syncConnectedAccountAgents(await findAgentsAssignedConnectedAccount(accountId))
  } catch (error) {
    console.warn(`[ConnectionSync] Failed to resolve agents assigned account ${accountId}:`, error)
    return false
  }
}

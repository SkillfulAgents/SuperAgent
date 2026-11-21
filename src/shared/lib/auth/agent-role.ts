/**
 * The agent-role policy the route middlewares (AgentRead / AgentUser /
 * AgentAdmin in src/api/middleware/auth.ts) apply, without a Hono context, for
 * callers that decide access for a user who is not the request's session (a
 * signed file URL redeemed on that user's behalf).
 */
import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import type { AgentRole } from '@shared/lib/types/agent'

/** An admin account is decided without a role: it may do anything an owner may. */
export function isAdminAccount(account: { role?: string | null }): boolean {
  return account.role === 'admin'
}

/** The user's `agent_acl` role on the agent, or null when they have none. */
export async function getUserAgentRole(userId: string, agentSlug: string): Promise<AgentRole | null> {
  const row = await db
    .select({ role: agentAcl.role })
    .from(agentAcl)
    .where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, agentSlug)))
    .limit(1)
  return (row[0]?.role as AgentRole) ?? null
}

/** The role the agent middlewares would authorize this account with on the agent: owner for an admin, else its ACL role. */
export async function effectiveAgentRole(account: { id: string; role?: string | null }, agentSlug: string): Promise<AgentRole | null> {
  if (isAdminAccount(account)) return 'owner'
  return getUserAgentRole(account.id, agentSlug)
}

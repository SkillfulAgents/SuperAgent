import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { hasMinRole, type AgentRole } from '@shared/lib/types/agent'

/** A user's own `agent_acl` role on an agent, or null when they hold none. */
export async function getUserAgentRole(userId: string, agentSlug: string): Promise<AgentRole | null> {
  const row = await db
    .select({ role: agentAcl.role })
    .from(agentAcl)
    .where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, agentSlug)))
    .limit(1)
  return (row[0]?.role as AgentRole) ?? null
}

/**
 * The AgentRead / AgentUser policy outside a request context: in non-auth
 * mode everyone (the `local` user) passes, an admin passes, anyone else needs
 * at least `minRole` on the agent.
 */
export async function userHasMinRoleOnAgent(
  user: { id: string; isAdmin: boolean },
  agentSlug: string,
  minRole: AgentRole,
): Promise<boolean> {
  if (!isAuthMode()) return true
  if (user.isAdmin) return true
  const role = await getUserAgentRole(user.id, agentSlug)
  return !!role && hasMinRole(role, minRole)
}

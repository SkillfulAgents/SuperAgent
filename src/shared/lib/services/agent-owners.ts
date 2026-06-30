import { and, asc, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'

/**
 * User ids that hold the 'owner' role on the given agent (auth mode), ordered by
 * userId so callers that take the first (e.g. integration owner attribution) get a
 * stable result when an agent has more than one owner. Empty in non-auth/single-user
 * mode, where ownership is the implicit 'local' user.
 */
export async function getAgentOwnerIds(agentSlug: string): Promise<string[]> {
  const rows = await db
    .select({ userId: agentAcl.userId })
    .from(agentAcl)
    .where(and(eq(agentAcl.agentSlug, agentSlug), eq(agentAcl.role, 'owner')))
    .orderBy(asc(agentAcl.userId))
  return rows.map((r) => r.userId)
}

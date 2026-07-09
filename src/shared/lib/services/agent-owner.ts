import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { and, asc, eq } from 'drizzle-orm'
import { isAuthMode } from '@shared/lib/auth/mode'

/**
 * The user who owns an agent, or null when there isn't one.
 *
 * `agent_acl` only carries rows in auth mode, so a single-user install always answers null — the
 * callers treat that as "no acting user", which is correct there (its platform credential is
 * already member-scoped).
 *
 * An agent may have SEVERAL owners (only "at least one" is enforced). Order by `createdAt` so the
 * answer is the agent's FIRST owner and cannot drift as co-owners are added or removed. It is not a
 * cosmetic tiebreak: this user becomes the acting member on billed platform-proxy calls, and the
 * proxy's billing gate reads a per-seat subscription (`subscriber:<seat>:sub_requests`) — so picking
 * a different owner can flip an allowed request to a 402.
 */
export function getAgentOwnerUserId(agentSlug: string): string | null {
  if (!isAuthMode()) return null
  const rows = db
    .select({ userId: agentAcl.userId })
    .from(agentAcl)
    .where(and(eq(agentAcl.agentSlug, agentSlug), eq(agentAcl.role, 'owner')))
    .orderBy(asc(agentAcl.createdAt))
    .limit(1)
    .all()
  return rows[0]?.userId ?? null
}

import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { isAuthMode } from '@shared/lib/auth/mode'

/**
 * The user who owns an agent, or null when there isn't one.
 *
 * `agent_acl` only carries rows in auth mode, so a single-user install always answers null — the
 * callers treat that as "no acting user", which is correct there (its platform credential is
 * already member-scoped).
 */
export function getAgentOwnerUserId(agentSlug: string): string | null {
  if (!isAuthMode()) return null
  const rows = db
    .select({ userId: agentAcl.userId })
    .from(agentAcl)
    .where(and(eq(agentAcl.agentSlug, agentSlug), eq(agentAcl.role, 'owner')))
    .limit(1)
    .all()
  return rows[0]?.userId ?? null
}

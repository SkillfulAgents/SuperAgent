import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { and, asc, eq } from 'drizzle-orm'
import { isAuthMode } from '@shared/lib/auth/mode'

/**
 * Agent owner userId, or null. Auth-mode only (`agent_acl`); single-user always null.
 * Ordered by createdAt (first owner) — this user is the acting member on billed proxy calls, so an
 * unordered pick can flip a seat-subscribed org between allowed and 402.
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

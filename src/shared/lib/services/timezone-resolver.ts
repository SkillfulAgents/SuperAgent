/**
 * Timezone Resolver
 *
 * Resolves the appropriate timezone for an agent context.
 * In auth mode, looks up the agent owner's timezone.
 * In non-auth mode, uses the 'local' user's timezone.
 */

import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getUserTimezone } from '@shared/lib/services/user-settings-service'

/**
 * Resolve the timezone to use for a scheduled task on a given agent.
 * - In non-auth mode: uses the 'local' user's timezone
 * - In auth mode: looks up the first owner of the agent and uses their timezone
 * - Falls back to the system timezone
 */
export function resolveTimezoneForAgent(agentSlug: string): string {
  if (!isAuthMode()) {
    return getUserTimezone('local')
  }

  // Auth mode: find the first owner of this agent
  const rows = db
    .select({ userId: agentAcl.userId })
    .from(agentAcl)
    .where(and(eq(agentAcl.agentSlug, agentSlug), eq(agentAcl.role, 'owner')))
    .limit(1)
    .all()

  if (rows.length > 0) {
    return getUserTimezone(rows[0].userId)
  }

  // Fallback: system timezone
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

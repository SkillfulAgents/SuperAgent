/**
 * Timezone Resolver
 *
 * Resolves the appropriate timezone for an agent context.
 * In auth mode, looks up the agent owner's timezone.
 * In non-auth mode, uses the 'local' user's timezone.
 */

import { isAuthMode } from '@shared/lib/auth/mode'
import { getAgentOwnerUserId } from '@shared/lib/services/agent-owner'
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
  const ownerUserId = getAgentOwnerUserId(agentSlug)
  if (ownerUserId) {
    return getUserTimezone(ownerUserId)
  }

  // Fallback: system timezone
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

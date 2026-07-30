import { messagePersister } from '@shared/lib/container/message-persister'
import { getSessionMetadata } from '@shared/lib/services/session-service'
import { normalizeAutopilotState } from './autopilot-schema'

/**
 * Whether an AGENT-scoped action (a proxied API/MCP call carries no sessionId)
 * should be treated as coming from an engaged autopilot session.
 *
 * Conservative on purpose: true only when the agent has at least one active
 * session and EVERY active session is engaged. With a mix (an interactive
 * session live alongside an engaged one) the call may belong to the
 * interactive session whose user is right there — park the review normally
 * rather than auto-deny work a present human could have approved.
 *
 * Lives apart from autopilot-service because it reads messagePersister, which
 * itself imports autopilot-service — route-level callers only.
 */
export async function isAgentAutopilotEngaged(agentSlug: string): Promise<boolean> {
  const activeSessionIds = messagePersister.getActiveSessionIdsForAgent(agentSlug)
  if (activeSessionIds.length === 0) return false
  for (const sessionId of activeSessionIds) {
    const state = normalizeAutopilotState(
      (await getSessionMetadata(agentSlug, sessionId))?.autopilot?.state
    )
    if (state !== 'engaged') return false
  }
  return true
}

import { messagePersister } from '@shared/lib/container/message-persister'
import { getSessionMetadata } from '@shared/lib/services/session-service'
import { normalizeAutopilotState } from './autopilot-schema'

/**
 * The authorization an autopilot approval is judged under: the set of engaged
 * sessions and the era marker each was engaged in. Captured before the model
 * review starts and revalidated immediately before the approved request is
 * forwarded — the user can switch autopilot off (or interrupt, which opens a
 * new era) while the review is in flight, and an approval judged under the
 * old authorization must not execute under the new one.
 */
export interface AutopilotAuthorization {
  sessions: Array<{ sessionId: string; requestedAt: string | undefined }>
}

/**
 * Snapshot the current autopilot authorization for an AGENT-scoped action (a
 * proxied API/MCP call carries no sessionId). Null unless autopilot is
 * engaged for the agent.
 *
 * Conservative on purpose: non-null only when the agent has at least one
 * active session and EVERY active session is engaged. With a mix (an
 * interactive session live alongside an engaged one) the call may belong to
 * the interactive session whose user is right there — park the review
 * normally rather than auto-deny work a present human could have approved.
 *
 * Lives apart from autopilot-service because it reads messagePersister, which
 * itself imports autopilot-service — route-level callers only.
 */
export async function getAutopilotAuthorization(
  agentSlug: string
): Promise<AutopilotAuthorization | null> {
  const activeSessionIds = messagePersister.getActiveSessionIdsForAgent(agentSlug)
  if (activeSessionIds.length === 0) return null
  const sessions: AutopilotAuthorization['sessions'] = []
  for (const sessionId of activeSessionIds) {
    const autopilot = (await getSessionMetadata(agentSlug, sessionId))?.autopilot
    if (normalizeAutopilotState(autopilot?.state) !== 'engaged') return null
    sessions.push({ sessionId, requestedAt: autopilot?.requestedAt })
  }
  return { sessions }
}

/**
 * Whether an authorization captured earlier still stands: the same sessions,
 * each still engaged, each in the same era. Any change — a disengage, an
 * interrupt's era restamp, a session appearing or disappearing — invalidates
 * the snapshot, and the pending approval must be dropped rather than
 * forwarded.
 */
export async function isAutopilotAuthorizationCurrent(
  agentSlug: string,
  authorization: AutopilotAuthorization
): Promise<boolean> {
  const current = await getAutopilotAuthorization(agentSlug)
  if (!current || current.sessions.length !== authorization.sessions.length) return false
  const currentEras = new Map(current.sessions.map((s) => [s.sessionId, s.requestedAt]))
  return authorization.sessions.every(
    (s) => currentEras.has(s.sessionId) && currentEras.get(s.sessionId) === s.requestedAt
  )
}

/** Boolean view of {@link getAutopilotAuthorization} for callers that only gate. */
export async function isAgentAutopilotEngaged(agentSlug: string): Promise<boolean> {
  return (await getAutopilotAuthorization(agentSlug)) !== null
}

/**
 * Thrown by the outbound-boundary guard when an autopilot approval no longer
 * authorizes the forward (revocation, era change, or request cancellation
 * during the awaits between the verdict and the actual outbound call). The
 * message is the user-facing reason; routes translate it into the standard
 * 403 `requires_user_approval` response and a `denied_autopilot` audit entry.
 */
export class AutopilotAuthorizationError extends Error {}

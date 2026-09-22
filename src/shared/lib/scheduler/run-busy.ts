import type { AgentActor } from '@shared/lib/agent-actor'

/**
 * Whether a recurring task's previous run still occupies its slot: busy and not
 * parked on user input. A parked run has nobody to answer it, so it frees the
 * slot; a run whose turn ended with background work still going stays active
 * and keeps it. Shared by the scheduler's overlap guard and "Run now" so the two
 * can't disagree.
 */
export function isRunBusy(actor: Pick<AgentActor, 'sessions'>, sessionId: string): boolean {
  return actor.sessions.isActive(sessionId) && !actor.sessions.isAwaitingInput(sessionId)
}

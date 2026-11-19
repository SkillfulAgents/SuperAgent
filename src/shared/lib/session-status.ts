import type { AgentLiveSummary } from '@shared/lib/agent-actor/types'

/** Every session-list endpoint uses the same live projection, including agent-scoped reviews. */
export function withSessionStatus<T extends { id: string }>(
  sessions: readonly T[],
  live: Pick<AgentLiveSummary, 'activeSessionIds' | 'awaitingSessionIds'>,
): (T & { isActive: boolean; isAwaitingInput: boolean })[] {
  const active = new Set(live.activeSessionIds)
  const awaiting = new Set(live.awaitingSessionIds)
  return sessions.map((session) => ({
    ...session,
    isActive: active.has(session.id),
    isAwaitingInput: awaiting.has(session.id),
  }))
}

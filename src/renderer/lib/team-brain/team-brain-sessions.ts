import type { ApiSession } from '@shared/lib/types/api'

/**
 * Team Brain shows human-started chats and scheduled runs currently waiting on a person.
 * The server's visible list already includes waiting automations through promotion; their
 * original source distinguishes them from chats after they finish. Ordering and limits belong to RelatedSessions.
 */
export function teamBrainSessions(sessions: readonly ApiSession[]): ApiSession[] {
  return sessions.filter((session) =>
    !session.origin || session.origin === 'user' || (session.origin === 'scheduled' && session.isAwaitingInput),
  )
}

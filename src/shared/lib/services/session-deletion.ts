import { and, eq, inArray } from 'drizzle-orm'
import { agentRegistry } from '@shared/lib/agent-actor'
import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'
import { deleteNotificationsBySessionIds } from './notification-service'
import { cancelPendingWakeForSession } from './scheduled-task-service'
import { deleteSessionUnreadMarks } from './session-unread-service'
import { unlinkTodosFromSessions } from './todo-service'

/**
 * Delete one session and what the host keeps about it outside the agent: the
 * one way a session is deleted, whoever asks (a person in the app, or the
 * agent itself through `/api/x-agent/sessions`).
 *
 * The actor's delete is the authority for existence: it removes the
 * transcript and/or a lingering index entry and answers false only when
 * neither existed, in which case nothing else is touched.
 */
export async function deleteSessionAndRecords(agentSlug: string, sessionId: string): Promise<boolean> {
  if (!(await agentRegistry.get(agentSlug).sessions.delete(sessionId))) return false

  // A pending wake targeting this session would otherwise fire into nothing
  // and be marked failed — cancel it alongside the session.
  await cancelPendingWakeForSession(agentSlug, sessionId).catch((error) => {
    console.error('Failed to cancel pending wake for deleted session:', error)
  })
  await deleteSessionRecords(agentSlug, [sessionId])
  return true
}

/**
 * What the host keeps, outside the agent, about sessions that were just
 * deleted. Every row is the agent's own: another agent may have a session
 * with the same id.
 */
export async function deleteSessionRecords(agentSlug: string, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return
  // Message author records: people (auth mode) and integrations (every mode).
  await db.delete(messageAuthor).where(and(eq(messageAuthor.agentSlug, agentSlug), inArray(messageAuthor.sessionId, sessionIds)))

  // Notification rows in BOTH modes (they are stored regardless of auth mode;
  // userId is nullable), so deleting a session never leaves stale
  // notification history pointing at it.
  await deleteNotificationsBySessionIds(agentSlug, sessionIds)
  // A mark left behind would be an unreachable row: nothing lists the
  // session any more, so nothing could ever clear it.
  await deleteSessionUnreadMarks(agentSlug, sessionIds)
  // A Todo board item started in one goes back to Drafts (or, if finished, keeps its place).
  await unlinkTodosFromSessions(agentSlug, sessionIds)
}

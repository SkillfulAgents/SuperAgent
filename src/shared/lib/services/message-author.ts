import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'

type AuthorRow = Pick<typeof messageAuthor.$inferInsert, 'id' | 'sessionId' | 'agentSlug' | 'userId' | 'authorAgentSlug' | 'billedUserId'>

/**
 * Record a person or calling agent before delivery. A failed write leaves
 * the message usable without a sender badge.
 */
export async function insertMessageAuthorBestEffort(params: AuthorRow): Promise<boolean> {
  try {
    await db.insert(messageAuthor).values(params)
    return true
  } catch (error) {
    console.warn('failed to record message author; continuing unattributed', {
      agentSlug: params.agentSlug,
      sessionId: params.sessionId,
      userId: params.userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/** Remove the attribution of a message that never reached the agent. Best-effort. */
export async function deleteMessageAuthorBestEffort(agentSlug: string, sessionId: string, messageUuid: string): Promise<void> {
  try {
    await db.delete(messageAuthor).where(and(
      eq(messageAuthor.agentSlug, agentSlug), eq(messageAuthor.sessionId, sessionId), eq(messageAuthor.id, messageUuid),
    ))
  } catch (error) {
    console.warn('failed to remove the attribution of an undelivered message', {
      messageUuid,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

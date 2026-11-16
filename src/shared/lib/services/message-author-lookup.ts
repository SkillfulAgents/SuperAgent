import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'

/**
 * Resolve the user who sent the message currently driving an agent session.
 * In shared sessions this can differ from the session creator, so what the
 * agent does for that message is attributed to the latest per-message author.
 */
export async function getLatestMessageAuthorUserId(
  agentSlug: string,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const rows = await db
      .select({ userId: messageAuthor.userId })
      .from(messageAuthor)
      .where(and(
        eq(messageAuthor.agentSlug, agentSlug),
        eq(messageAuthor.sessionId, sessionId),
        // An integration-delivered message has no user author.
        isNotNull(messageAuthor.userId),
      ))
      .orderBy(desc(messageAuthor.createdAt), desc(messageAuthor.id))
      .limit(1)
    return rows[0]?.userId ?? undefined
  } catch (error) {
    // Attribution is optional. A DB/read failure must never block the caller.
    console.warn('[x-agent] failed to resolve triggering message author; continuing unattributed', {
      agentSlug,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

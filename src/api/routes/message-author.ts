import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'

/**
 * Record who authored a user message (auth mode). Best-effort: a stale userId
 * whose user row is gone throws on the FK; the session stays usable and only
 * the sender badge is lost.
 */
export async function insertMessageAuthorBestEffort(params: {
  id: string
  sessionId: string
  agentSlug: string
  userId: string
}): Promise<boolean> {
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

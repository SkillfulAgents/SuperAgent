import { and, asc, eq, inArray, isNotNull, min } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'
import { getUserSummaries } from '@shared/lib/services/user-profile-service'

// Keeps each IN (…) list well under every driver's bound-parameter limit.
const SESSION_ID_CHUNK = 500

export type SessionParticipant = Awaited<ReturnType<typeof getUserSummaries>> extends Map<string, infer P> ? P : never

/**
 * The people who wrote in each session, in the order they first did. Read from
 * the message attribution rows (auth mode records one per user message), so a
 * session nobody has written in, or one only integrations wrote in, is absent.
 * Callers authorize the agent first; the sessions must belong to it.
 */
export async function getSessionParticipants(
  agentSlug: string,
  sessionIds: readonly string[],
): Promise<Map<string, SessionParticipant[]>> {
  const ids = [...new Set(sessionIds)]
  const rows: { sessionId: string; userId: string }[] = []
  for (let i = 0; i < ids.length; i += SESSION_ID_CHUNK) {
    const chunk = ids.slice(i, i + SESSION_ID_CHUNK)
    const firstAt = min(messageAuthor.createdAt)
    const found = await db
      .select({ sessionId: messageAuthor.sessionId, userId: messageAuthor.userId, firstAt })
      .from(messageAuthor)
      .where(and(
        eq(messageAuthor.agentSlug, agentSlug),
        inArray(messageAuthor.sessionId, chunk),
        isNotNull(messageAuthor.userId),
      ))
      .groupBy(messageAuthor.sessionId, messageAuthor.userId)
      .orderBy(asc(firstAt), asc(messageAuthor.userId))
      .all()
    for (const row of found) if (row.userId) rows.push({ sessionId: row.sessionId, userId: row.userId })
  }

  const profiles = await getUserSummaries(rows.map(row => row.userId))
  const bySession = new Map<string, SessionParticipant[]>()
  for (const row of rows) {
    const profile = profiles.get(row.userId)
    if (!profile) continue
    const list = bySession.get(row.sessionId)
    if (list) list.push(profile)
    else bySession.set(row.sessionId, [profile])
  }
  return bySession
}

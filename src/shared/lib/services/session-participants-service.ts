import { and, asc, desc, eq, inArray, isNotNull, min } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { maxBoundParameters } from '@shared/lib/db/bound-parameters'
import { messageAuthor } from '@shared/lib/db/schema'
import { getUserSummaries } from '@shared/lib/services/user-profile-service'

/** Session ids per statement at most, on a driver with SQLite's own bound-parameter limit. */
const MAX_SESSION_IDS_PER_STATEMENT = 500

export type SessionParticipant = Awaited<ReturnType<typeof getUserSummaries>> extends Map<string, infer P> ? P : never

/**
 * The person who sent the session's latest message. In a shared session this
 * can differ from who created it.
 */
export async function getLatestMessageAuthorUserId(
  agentSlug: string,
  sessionId: string,
): Promise<string | undefined> {
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
}

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
  // The agent's slug is the one other parameter.
  const perStatement = Math.min(MAX_SESSION_IDS_PER_STATEMENT, maxBoundParameters() - 1)
  for (let i = 0; i < ids.length; i += perStatement) {
    const chunk = ids.slice(i, i + perStatement)
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

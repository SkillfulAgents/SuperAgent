import { and, asc, eq, isNotNull, min } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { inList } from '@shared/lib/db/bound-parameters'
import { messageAuthor, user } from '@shared/lib/db/schema'
import { toUserProfile, userProfileFields } from '@shared/lib/services/user-profile-service'

/**
 * The most session ids sent with the statement: a bounded list (`?limit=`, at
 * most SESSIONS_LIST_MAX_LIMIT) fits. A longer one is the agent's whole session
 * list, which is not sent at all: the agent's rows are read and matched here.
 */
const MAX_SESSION_IDS_IN_STATEMENT = 100

export type SessionParticipant = ReturnType<typeof toUserProfile>

/** Exported for tests of the statement's shape. */
export function sessionParticipantsQuery(agentSlug: string, ids: ReadonlySet<string>) {
  // One statement and at most two bound parameters however many sessions there
  // are (Cloudflare D1 allows 100 per statement): the ids travel as one JSON
  // array read with `json_each` (`inList`).
  const named = ids.size <= MAX_SESSION_IDS_IN_STATEMENT
  // Grouped before the join, so a user is looked up once per session they
  // wrote in, not once per message.
  const wrote = db
    .select({
      sessionId: messageAuthor.sessionId,
      userId: messageAuthor.userId,
      firstAt: min(messageAuthor.createdAt).as('first_at'),
    })
    .from(messageAuthor)
    .where(and(
      eq(messageAuthor.agentSlug, agentSlug),
      named ? inList(messageAuthor.sessionId, [...ids]) : undefined,
      isNotNull(messageAuthor.userId),
    ))
    .groupBy(messageAuthor.sessionId, messageAuthor.userId)
    .as('wrote')
  return db
    .select({ sessionId: wrote.sessionId, ...userProfileFields() })
    .from(wrote)
    .innerJoin(user, eq(user.id, wrote.userId))
    .orderBy(asc(wrote.firstAt), asc(wrote.userId))
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
  const ids = new Set(sessionIds)
  if (ids.size === 0) return new Map()
  const rows = await sessionParticipantsQuery(agentSlug, ids).all()

  const bySession = new Map<string, SessionParticipant[]>()
  const profiles = new Map<string, SessionParticipant>()
  for (const row of rows) {
    const { sessionId } = row
    if (!ids.has(sessionId)) continue
    let profile = profiles.get(row.id)
    if (!profile) profiles.set(row.id, profile = toUserProfile(row))
    const list = bySession.get(sessionId)
    if (list) list.push(profile)
    else bySession.set(sessionId, [profile])
  }
  return bySession
}

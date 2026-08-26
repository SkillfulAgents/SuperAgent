/**
 * Session "Mark as Unread" marks.
 *
 * A second source of truth for the sidebar's unread dot, alongside unread rows
 * in `notifications`. Every consumer of that projection has to OR the two
 * together — see the producers of `hasUnreadNotifications` in the agents route.
 *
 * Why a table and not a field on session metadata: the dot is projected on
 * polled endpoints, and session metadata is a per-agent JSON map that costs a
 * file read plus a Zod parse of every session's entry to answer "is anything
 * marked?". The perf suite pins the notable fast path at zero file reads, so a
 * metadata-backed flag would have put an O(sessions) read back on a hot poll.
 * A query here costs no filesystem work at all.
 *
 * Every function is scoped to one user. Unlike notification read state — which
 * is deliberately shared, because it records a team-visible acknowledgement — a
 * mark records one person's intent to come back to a session. A teammate
 * opening the session must not clear your reminder, and your reminder must not
 * raise a dot on their sidebar. `userId` is the `getCurrentUserId()` value,
 * which is the `'local'` sentinel outside auth mode.
 */

import { db } from '@shared/lib/db'
import { sessionUnreadMarks } from '@shared/lib/db/schema'
import { and, eq, inArray } from 'drizzle-orm'

/**
 * Raise this user's mark. Idempotent: re-marking keeps the original timestamp
 * and reports no change.
 *
 * Returns whether a row was actually written, so callers can skip the cache
 * invalidation a no-op would otherwise trigger.
 */
export async function markSessionUnread(
  agentSlug: string,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .insert(sessionUnreadMarks)
    .values({ sessionId, userId, agentSlug, markedAt: new Date() })
    .onConflictDoNothing()

  return (result.changes ?? 0) > 0
}

/**
 * Clear this user's mark, leaving anyone else's alone. Fires on every session
 * open, so the overwhelmingly common case deletes no row and reports false.
 */
export async function clearSessionUnread(sessionId: string, userId: string): Promise<boolean> {
  const result = await db
    .delete(sessionUnreadMarks)
    .where(and(eq(sessionUnreadMarks.sessionId, sessionId), eq(sessionUnreadMarks.userId, userId)))

  return (result.changes ?? 0) > 0
}

/** Session ids this user marked unread on one agent. */
export async function getSessionIdsMarkedUnread(
  agentSlug: string,
  userId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ sessionId: sessionUnreadMarks.sessionId })
    .from(sessionUnreadMarks)
    .where(and(eq(sessionUnreadMarks.agentSlug, agentSlug), eq(sessionUnreadMarks.userId, userId)))

  return new Set(rows.map((r) => r.sessionId))
}

/**
 * Batch version for the agents list, which hydrates every agent per poll.
 * Mirrors getUnreadNotificationsByAgents so the two halves of the projection
 * cost one query each rather than one per agent.
 */
export async function getSessionIdsMarkedUnreadByAgents(
  agentSlugs: string[],
  userId: string,
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>()
  if (agentSlugs.length === 0) return result

  const rows = await db
    .select({ agentSlug: sessionUnreadMarks.agentSlug, sessionId: sessionUnreadMarks.sessionId })
    .from(sessionUnreadMarks)
    .where(and(
      inArray(sessionUnreadMarks.agentSlug, agentSlugs),
      eq(sessionUnreadMarks.userId, userId),
    ))

  for (const row of rows) {
    let set = result.get(row.agentSlug)
    if (!set) { set = new Set(); result.set(row.agentSlug, set) }
    set.add(row.sessionId)
  }
  return result
}

/**
 * Drop every user's marks for deleted sessions, alongside
 * deleteNotificationsBySessionIds — otherwise a mark would outlive its session
 * as an unreachable row.
 */
export async function deleteSessionUnreadMarks(sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0

  const result = await db
    .delete(sessionUnreadMarks)
    .where(inArray(sessionUnreadMarks.sessionId, sessionIds))

  return result.changes ?? 0
}

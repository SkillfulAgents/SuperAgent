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
 * Marks are shared, not per-user, matching notification read state (see the
 * comment on the `notifications` table). Whoever next opens the session clears
 * it for everyone.
 */

import { db } from '@shared/lib/db'
import { sessionUnreadMarks } from '@shared/lib/db/schema'
import { eq, inArray } from 'drizzle-orm'

/**
 * Raise the mark. Idempotent: re-marking an already-marked session keeps the
 * original timestamp and reports no change.
 *
 * Returns whether a row was actually written, so callers can skip the cache
 * invalidation a no-op would otherwise trigger.
 */
export async function markSessionUnread(agentSlug: string, sessionId: string): Promise<boolean> {
  const result = await db
    .insert(sessionUnreadMarks)
    .values({ sessionId, agentSlug, markedAt: new Date() })
    .onConflictDoNothing()

  return (result.changes ?? 0) > 0
}

/**
 * Clear the mark. Fires on every session open, so the overwhelmingly common
 * case is a session that was never marked — that deletes no rows and reports
 * false.
 */
export async function clearSessionUnread(sessionId: string): Promise<boolean> {
  const result = await db
    .delete(sessionUnreadMarks)
    .where(eq(sessionUnreadMarks.sessionId, sessionId))

  return (result.changes ?? 0) > 0
}

/** Session ids marked unread for one agent. */
export async function getSessionIdsMarkedUnread(agentSlug: string): Promise<Set<string>> {
  const rows = await db
    .select({ sessionId: sessionUnreadMarks.sessionId })
    .from(sessionUnreadMarks)
    .where(eq(sessionUnreadMarks.agentSlug, agentSlug))

  return new Set(rows.map((r) => r.sessionId))
}

/**
 * Batch version for the agents list, which hydrates every agent per poll.
 * Mirrors getUnreadNotificationsByAgents so the two halves of the projection
 * cost one query each rather than one per agent.
 */
export async function getSessionIdsMarkedUnreadByAgents(
  agentSlugs: string[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>()
  if (agentSlugs.length === 0) return result

  const rows = await db
    .select({ agentSlug: sessionUnreadMarks.agentSlug, sessionId: sessionUnreadMarks.sessionId })
    .from(sessionUnreadMarks)
    .where(inArray(sessionUnreadMarks.agentSlug, agentSlugs))

  for (const row of rows) {
    let set = result.get(row.agentSlug)
    if (!set) { set = new Set(); result.set(row.agentSlug, set) }
    set.add(row.sessionId)
  }
  return result
}

/**
 * Drop marks for deleted sessions, alongside deleteNotificationsBySessionIds —
 * otherwise a mark would outlive its session as an unreachable row.
 */
export async function deleteSessionUnreadMarks(sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0

  const result = await db
    .delete(sessionUnreadMarks)
    .where(inArray(sessionUnreadMarks.sessionId, sessionIds))

  return result.changes ?? 0
}

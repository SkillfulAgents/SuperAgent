import { eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { authSession } from '@shared/lib/db/schema'
import type { SessionCreationMethod } from './session-audit'

/**
 * Session-creation methods exempt from the concurrent-session cap.
 *
 * The cap bounds how many *interactive* sessions a user accumulates across
 * browsers and devices. A session minted by the RFC 7523 token exchange is not
 * one of those: it belongs to a client the user installed, it is re-minted on
 * a schedule the user never sees, and it is revoked by disconnecting that
 * client rather than by signing out.
 *
 * Without the exemption the interaction is harmful in both directions.
 * Eviction is oldest-first and the oldest session is almost always the
 * long-lived browser one, so a daily re-mint would walk a user's browser
 * sessions off the end. In the other direction, a few browser logins would
 * silently evict the installed client's session — which re-mints, evicting
 * another browser session.
 *
 * Type-only import so this stays free of the audit service at runtime; the
 * annotation is what keeps the string in step with the method list.
 */
const UNCAPPED_CREATION_METHODS: readonly SessionCreationMethod[] = ['token-exchange']

function isCapped(creationMethod: string | null): boolean {
  // Rows predating the `creation_method` column read null. Counting them is
  // the safe default: it preserves existing behaviour for every session this
  // code has not labelled, and the alternative would exempt them wholesale.
  return !UNCAPPED_CREATION_METHODS.includes(creationMethod as SessionCreationMethod)
}

/**
 * Delete oldest sessions for a user when they exceed the max allowed.
 * Returns the number of sessions deleted.
 *
 * Exempt sessions are excluded from both the count and the deletion
 * candidates — they neither push another session out nor get pushed out.
 */
export function enforceMaxConcurrentSessions(userId: string, maxSessions: number): number {
  const userSessions = db
    .select({
      id: authSession.id,
      createdAt: authSession.createdAt,
      creationMethod: authSession.creationMethod,
    })
    .from(authSession)
    .where(eq(authSession.userId, userId))
    .orderBy(authSession.createdAt)
    .all()

  // Filtered in memory rather than in SQL: the set is bounded by the cap plus
  // a handful, and `creation_method IS NOT 'x'` has null semantics that are
  // easy to get subtly wrong in a where clause.
  const capped = userSessions.filter((s) => isCapped(s.creationMethod))

  if (capped.length > maxSessions) {
    const toDelete = capped.slice(0, capped.length - maxSessions)
    for (const s of toDelete) {
      db.delete(authSession)
        .where(eq(authSession.id, s.id))
        .run()
    }
    return toDelete.length
  }
  return 0
}

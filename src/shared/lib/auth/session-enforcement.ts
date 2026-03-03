import { eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { authSession } from '@shared/lib/db/schema'

/**
 * Delete oldest sessions for a user when they exceed the max allowed.
 * Returns the number of sessions deleted.
 */
export function enforceMaxConcurrentSessions(userId: string, maxSessions: number): number {
  const userSessions = db
    .select({ id: authSession.id, createdAt: authSession.createdAt })
    .from(authSession)
    .where(eq(authSession.userId, userId))
    .orderBy(authSession.createdAt)
    .all()

  if (userSessions.length > maxSessions) {
    const toDelete = userSessions.slice(0, userSessions.length - maxSessions)
    for (const s of toDelete) {
      db.delete(authSession)
        .where(eq(authSession.id, s.id))
        .run()
    }
    return toDelete.length
  }
  return 0
}

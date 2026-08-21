import { eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { authSession } from '@shared/lib/db/schema'
import type { SessionCreationMethod } from './session-audit'

/**
 * Session-creation methods held to their own bound rather than the interactive
 * one.
 *
 * `maxConcurrentSessions` bounds how many *interactive* sessions a user
 * accumulates across browsers and devices. A session minted by the RFC 7523
 * token exchange is not one of those: it belongs to a client the user
 * installed, it is re-minted on a schedule they never see, and it is revoked by
 * disconnecting that client rather than by signing out.
 *
 * Mixing the two is harmful in both directions. Eviction is oldest-first and
 * the oldest session is almost always the long-lived browser one, so a daily
 * re-mint would walk a user's browser sessions off the end. In the other
 * direction, a few browser logins would silently evict the installed client's
 * session — which re-mints, evicting another browser session.
 *
 * Mobile-paired sessions live on the same side of the line: they belong to an
 * installed app, are long-lived by design (90 days), and are revoked from the
 * paired-devices list rather than by signing out — letting browser logins
 * evict them (or vice versa) would be the same failure mode.
 *
 * Type-only import so this stays free of the audit service at runtime; the
 * annotation is what keeps the string in step with the method list.
 */
const NON_INTERACTIVE_CREATION_METHODS: readonly SessionCreationMethod[] = [
  'token-exchange',
  'mobile',
]

/**
 * Ceiling on *live* non-interactive sessions per user.
 *
 * Separating these from the interactive cap must not mean removing their
 * bound. Nothing in this codebase prunes expired sessions, and a client
 * re-mints on a schedule, so "never evicted" would mean a row per re-mint
 * forever — in a table read in full on every single login.
 *
 * Generous on purpose: this is a backstop against unbounded growth, not a
 * device limit. Expired rows are pruned below, so the steady state is roughly
 * one row per machine and this ceiling is never reached in normal use.
 */
const MAX_NON_INTERACTIVE_SESSIONS = 10

interface SessionRow {
  id: string
  createdAt: Date
  expiresAt: Date
  creationMethod: string | null
}

function isNonInteractive(creationMethod: string | null): boolean {
  // Rows predating the `creation_method` column read null. Treating them as
  // interactive is the safe default: it preserves existing behaviour for every
  // session this code has not labelled, and the alternative would move an
  // entire installed base onto the other bound.
  return NON_INTERACTIVE_CREATION_METHODS.includes(creationMethod as SessionCreationMethod)
}

/** Defensive about the shape: a row with no usable expiry counts as live. */
function isExpired(expiresAt: Date | null | undefined): boolean {
  return expiresAt instanceof Date && expiresAt.getTime() <= Date.now()
}

/** The oldest rows above `max`; `rows` must already be oldest-first. */
function overflow<T>(rows: T[], max: number): T[] {
  return rows.length > max ? rows.slice(0, rows.length - max) : []
}

/**
 * Delete a user's excess sessions. Returns the number deleted.
 *
 * Interactive sessions (browser logins) are held to `maxSessions`;
 * non-interactive ones to their own ceiling, having first dropped any that
 * have expired. The two groups never evict each other.
 */
export function enforceMaxConcurrentSessions(userId: string, maxSessions: number): number {
  const userSessions = db
    .select({
      id: authSession.id,
      createdAt: authSession.createdAt,
      expiresAt: authSession.expiresAt,
      creationMethod: authSession.creationMethod,
    })
    .from(authSession)
    .where(eq(authSession.userId, userId))
    .orderBy(authSession.createdAt)
    .all() as SessionRow[]

  // Partitioned in memory rather than in SQL: the set is small, and
  // `creation_method IS NOT 'x'` has null semantics that are easy to get subtly
  // wrong in a where clause.
  const interactive: SessionRow[] = []
  const nonInteractive: SessionRow[] = []
  for (const session of userSessions) {
    ;(isNonInteractive(session.creationMethod) ? nonInteractive : interactive).push(session)
  }

  // Expired non-interactive rows go first, so the ceiling below is spent on
  // sessions that can still authenticate rather than on dead weight.
  //
  // Scoped to non-interactive deliberately. Pruning expired *interactive* rows
  // would change the effective cap for every existing deployment — those rows
  // are counted today — which is a separate decision from this one.
  const expired = nonInteractive.filter((s) => isExpired(s.expiresAt))
  const live = nonInteractive.filter((s) => !isExpired(s.expiresAt))

  const doomed = [
    ...overflow(interactive, maxSessions),
    ...expired,
    ...overflow(live, MAX_NON_INTERACTIVE_SESSIONS),
  ]

  for (const session of doomed) {
    db.delete(authSession)
      .where(eq(authSession.id, session.id))
      .run()
  }
  return doomed.length
}

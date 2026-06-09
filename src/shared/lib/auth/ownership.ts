/**
 * AUTH_MODE ownership helpers.
 *
 * Across the API, resource access in multi-user (AUTH_MODE) deployments must be
 * scoped to the acting user: a list query filters by `userId`, and a handler
 * that loads a record by a caller-supplied id must reject it if it belongs to
 * someone else (SUP-198/199). In single-user / Electron mode there is no user
 * to scope to, so these checks must be no-ops.
 *
 * These helpers encapsulate the `isAuthMode() && ... getCurrentUserId(c)`
 * boilerplate so call sites stay readable:
 *   - ownerScope(c, col)        → a WHERE fragment, or undefined in non-auth mode
 *   - isOwnedByCaller(c, record) → boolean (always true in non-auth mode)
 *
 * Both are no-ops outside AUTH_MODE.
 */

import type { Context } from 'hono'
import { eq, type Column, type SQL } from 'drizzle-orm'
import { isAuthMode } from './mode'
import { getCurrentUserId } from './config'

/**
 * A drizzle WHERE fragment scoping `column` to the acting user — or `undefined`
 * in non-auth mode. `and()` ignores undefined, so spread it directly:
 *
 *   .where(and(inArray(table.id, ids), ownerScope(c, table.userId)))
 */
export function ownerScope(c: Context, column: Column): SQL | undefined {
  if (!isAuthMode()) return undefined
  return eq(column, getCurrentUserId(c))
}

/**
 * True when `record` is owned by the acting user. Always true in non-auth mode.
 *
 * The caller owns the existence check, so the canonical guard is:
 *   if (!record || !isOwnedByCaller(c, record)) return c.json({ error: 'Not found' }, 404)
 */
export function isOwnedByCaller(
  c: Context,
  record: { userId?: string | null } | null | undefined,
): boolean {
  if (!isAuthMode()) return true
  return !!record && record.userId === getCurrentUserId(c)
}

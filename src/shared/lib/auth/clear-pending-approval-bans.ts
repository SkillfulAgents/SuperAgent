import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import * as schema from '@shared/lib/db/schema'
import { isPlatformControlledAuth } from './auth-settings'

export const PENDING_APPROVAL_BAN_REASON = 'Pending admin approval'

/** One-time upgrade clear: platform-controlled deployments have no local approve UI. */
export function clearPendingApprovalBans(): number {
  if (!isPlatformControlledAuth()) return 0
  const result = db
    .update(schema.user)
    .set({ banned: false, banReason: null })
    .where(
      and(eq(schema.user.banned, true), eq(schema.user.banReason, PENDING_APPROVAL_BAN_REASON)),
    )
    .run()
  if (result.changes > 0) {
    console.log(
      `Cleared ${result.changes} pending-approval ban(s) (platform-controlled auth)`,
    )
  }
  return result.changes
}

import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import * as schema from '@shared/lib/db/schema'
import { isPlatformControlledAuth } from './auth-settings'

export const PENDING_APPROVAL_BAN_REASON = 'Pending admin approval'

/** One-time upgrade clear: platform-controlled deployments have no local approve UI. */
export async function clearPendingApprovalBans(): Promise<number> {
  if (!isPlatformControlledAuth()) return 0
  const result = await db
    .update(schema.user)
    .set({ banned: false, banReason: null })
    .where(
      and(eq(schema.user.banned, true), eq(schema.user.banReason, PENDING_APPROVAL_BAN_REASON)),
    )
    .run()
  if (changesOf(result) > 0) {
    console.log(
      `Cleared ${changesOf(result)} pending-approval ban(s) (platform-controlled auth)`,
    )
  }
  return changesOf(result)
}

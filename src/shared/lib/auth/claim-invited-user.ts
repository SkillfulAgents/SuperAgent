/**
 * Claiming an invited user: the row made for someone shared with or mentioned
 * before they joined (team-directory/invited-users.ts) becomes theirs the
 * first time it gets an account.
 *
 * - Signing in with OIDC or Google links that login to the row by its email
 *   (Better Auth's implicit linking). Linking never fires `user.create`, so the
 *   claim runs from `databaseHooks.account.create.after` (auth/index.ts).
 * - A password is set through the invite link instead (api/routes/invite-claim.ts),
 *   which calls this directly.
 *
 * What joining does for a user Better Auth creates, a claim does here: the
 * role (a Platform member's role on a platform-controlled deployment, the
 * default role otherwise), admin approval when it is required, and the Team
 * Brain. Their access and waiting notifications are already on the row.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { agentAcl, user } from '@shared/lib/db/schema'
import { getSettings } from '@shared/lib/config/settings'
import { resolveAuthSettings } from './auth-settings'
import { platformJoinRole } from './platform-role'
import { PENDING_APPROVAL_BAN_REASON } from './clear-pending-approval-bans'
import { revokeInviteTokens } from './invite-tokens'

/** Makes an invited user a member. False when `userId` is not invited (already claimed, or never invited): nothing changes. */
export async function claimInvitedUser(userId: string): Promise<boolean> {
  // Every account creation comes through here; most are not a claim.
  const current = await db.select({ status: user.status }).from(user).where(eq(user.id, userId)).get()
  if (current?.status !== 'invited') return false
  const authSettings = resolveAuthSettings((await getSettings()).auth)
  const role = platformJoinRole() ?? (authSettings.defaultUserRole === 'admin' ? 'admin' : 'user')
  const pendingApproval = authSettings.requireAdminApproval === true
  // The status is the claim: of two sign-ins racing to link, one flips it.
  const claimed = changesOf(await db.update(user).set({
    status: 'active',
    role,
    // The directory vouched for it, and so did whoever just proved it: the
    // OIDC provider, or the Slack DM the invite link came in.
    emailVerified: true,
    ...(pendingApproval ? { banned: true, banReason: PENDING_APPROVAL_BAN_REASON } : {}),
    updatedAt: new Date(),
  }).where(and(eq(user.id, userId), eq(user.status, 'invited'))).run()) > 0
  if (!claimed) return false
  console.log(`[Auth] Invited user ${userId} joined${pendingApproval ? ', pending admin approval' : ''}`)

  await revokeInviteTokens(userId).catch((error) => console.error('Failed to revoke a joined user’s invite links:', error))
  const { addTeamBrainUser, notifyAgentMembersChanged } = await import('@shared/lib/services/agent-members-service')
  await addTeamBrainUser(userId).catch((error) => console.error('Failed to give a joined member the Team Brain:', error))
  // Their agents' rosters stop showing them as invited.
  const agents = await db.select({ agentSlug: agentAcl.agentSlug }).from(agentAcl).where(eq(agentAcl.userId, userId)).all()
  for (const { agentSlug } of agents) await notifyAgentMembersChanged(agentSlug)
  return true
}

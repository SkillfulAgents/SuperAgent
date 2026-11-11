/**
 * Claiming an invited user: the row made for someone shared with or mentioned
 * before they joined (team-directory/invited-users.ts) becomes theirs the
 * first time it gets an account.
 *
 * - Signing in with OIDC or Google links that login to the row by its email
 *   (Better Auth's implicit linking). Linking never fires `user.create`, so the
 *   claim runs from `databaseHooks.account.create.after` (auth/index.ts).
 * - Signing up with a password and the row's email sets the password on the
 *   row instead of creating a user (`claimInvitedUserWithPassword`, from the
 *   sign-up route's middleware). As with any sign-up here, owning the email
 *   isn't checked.
 *
 * What joining does for a user Better Auth creates, a claim does here: the
 * role (a Platform member's role on a platform-controlled deployment, the
 * default role otherwise), admin approval when it is required, and the Team
 * Brain. Their access and waiting notifications are already on the row.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'
import { db } from '@shared/lib/db'
import { changesOf, insertWhere } from '@shared/lib/db/batch'
import { agentAcl, authAccount, user } from '@shared/lib/db/schema'
import { getSettings } from '@shared/lib/config/settings'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { resolveAuthSettings } from './auth-settings'
import { platformJoinRole } from './platform-role'
import { PENDING_APPROVAL_BAN_REASON } from './clear-pending-approval-bans'

/**
 * Makes an invited user a member. False when `userId` is not invited (already
 * claimed, or never invited): nothing changes. `emailVerified` says whether
 * whoever claims it proved the email (an SSO provider did; a password sign-up didn't).
 */
export async function claimInvitedUser(userId: string, options: { emailVerified?: boolean } = {}): Promise<boolean> {
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
    emailVerified: options.emailVerified ?? true,
    ...(pendingApproval ? { banned: true, banReason: PENDING_APPROVAL_BAN_REASON } : {}),
    updatedAt: new Date(),
  }).where(and(eq(user.id, userId), eq(user.status, 'invited'))).run()) > 0
  if (!claimed) return false
  console.log(`[Auth] Invited user ${userId} joined${pendingApproval ? ', pending admin approval' : ''}`)
  trackServerEvent('invited_user_joined', { email_verified: options.emailVerified ?? true, pending_approval: pendingApproval })

  const { addTeamBrainUser, notifyAgentMembersChanged } = await import('@shared/lib/services/agent-members-service')
  await addTeamBrainUser(userId).catch((error) => console.error('Failed to give a joined member the Team Brain:', error))
  // Their agents' rosters stop showing them as invited.
  const agents = await db.select({ agentSlug: agentAcl.agentSlug }).from(agentAcl).where(eq(agentAcl.userId, userId)).all()
  for (const { agentSlug } of agents) await notifyAgentMembersChanged(agentSlug)
  return true
}

/** The invited user an email names (any case), if it is still waiting to be claimed. */
export async function invitedUserByEmail(email: string): Promise<{ id: string; email: string; name: string } | null> {
  const row = await db.select({ id: user.id, email: user.email, name: user.name, status: user.status }).from(user)
    .where(sql`lower(${user.email}) = ${email.trim().toLowerCase()}`).get()
  return row?.status === 'invited' ? { id: row.id, email: row.email, name: row.name } : null
}

/**
 * Joins an invited user with a password, as signing up would have made them a
 * user: the password goes on the row, then it is claimed. False when it was
 * claimed meanwhile (an SSO sign-in, another sign-up): nothing changes.
 */
export async function claimInvitedUserWithPassword(userId: string, input: { name: string; password: string }): Promise<boolean> {
  const now = new Date()
  // One statement decides: the password goes on only while the row is still
  // invited and has none, so two sign-ups (or one racing an SSO sign-in) can't both set one.
  const added = changesOf(await insertWhere(authAccount, {
    id: randomUUID(),
    accountId: userId,
    providerId: 'credential',
    userId,
    password: await hashPassword(input.password),
    createdAt: now,
    updatedAt: now,
  }, sql`exists (select 1 from ${user} where ${user.id} = ${userId} and ${user.status} = 'invited')
    and not exists (select 1 from ${authAccount} where ${authAccount.userId} = ${userId} and ${authAccount.providerId} = 'credential')`).run())
  if (!added) return false
  await claimInvitedUser(userId, { emailVerified: false })
  await db.update(user).set({ name: input.name, updatedAt: new Date() }).where(eq(user.id, userId)).run()
  return true
}

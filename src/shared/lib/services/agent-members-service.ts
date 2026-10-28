import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { agentAcl, user } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getTeamBrain } from '@shared/lib/config/settings'
import { hasMinRole } from '@shared/lib/types/agent'
import { agentMembersByAgentSchema, type AgentMember } from '@shared/lib/agent-members-schema'
import { getUserSummaries } from './user-profile-service'
import { publishCollaborationEvent } from './collaboration-events'

/** Callers must authorize every agent before reading its roster. */
export async function listAgentMembersByAgent(agentSlugs: readonly string[]) {
  const slugs = [...new Set(agentSlugs)]
  const members = new Map(slugs.map(slug => [slug, [] as AgentMember[]]))
  if (!slugs.length) return {}
  const rows = await db.select({ agentSlug: agentAcl.agentSlug, id: agentAcl.userId, role: agentAcl.role }).from(agentAcl)
    .where(inArray(agentAcl.agentSlug, slugs))
    // Joining time + stable ID keep faces stationary when names or roles change.
    .orderBy(asc(agentAcl.createdAt), asc(agentAcl.userId)).all()
  const profiles = await getUserSummaries(rows.map(row => row.id))
  for (const row of rows) {
    const profile = profiles.get(row.id)
    if (profile) members.get(row.agentSlug)!.push({ ...profile, role: row.role })
  }
  return agentMembersByAgentSchema.parse(Object.fromEntries(members))
}

export async function listAgentMembers(agentSlug: string) {
  return (await listAgentMembersByAgent([agentSlug]))[agentSlug]
}

export type AgentRole = AgentMember['role']

/** How many members hold at least `minRole` on the agent. */
export async function countMembersWithMinRole(agentSlug: string, minRole: AgentRole): Promise<number> {
  const roles = agentAcl.role.enumValues.filter(role => hasMinRole(role, minRole))
  const row = await db.select({ n: count() }).from(agentAcl)
    .where(and(eq(agentAcl.agentSlug, agentSlug), inArray(agentAcl.role, roles))).get()
  return row?.n ?? 0
}

/**
 * How many people besides `userId` can have the agent act for them: its
 * members who may message it (user and owner, not viewers), and every admin,
 * who may drive any agent. Banned accounts sign in to nothing. All of them
 * for null (non-auth mode's one person).
 */
export async function countOtherMembers(agentSlug: string, userId: string | null): Promise<number> {
  const roles = agentAcl.role.enumValues.filter(role => hasMinRole(role, 'user'))
  const members = db.select({ id: agentAcl.userId }).from(agentAcl)
    .where(and(eq(agentAcl.agentSlug, agentSlug), inArray(agentAcl.role, roles)))
  const row = await db.select({ n: count() }).from(user).where(and(
    or(eq(user.role, 'admin'), inArray(user.id, members)),
    or(eq(user.banned, false), isNull(user.banned)),
    userId === null ? undefined : ne(user.id, userId),
  )).get()
  return row?.n ?? 0
}

/** Why a member write changed nothing, or `done`. */
export type MemberWriteOutcome = 'done' | 'not-a-member' | 'last-owner'

/**
 * The matched `agent_acl` row is not the agent's only owner. The count is a
 * subquery the driver evaluates inside the write itself, so two concurrent
 * revokes cannot both pass a check that was true when each of them looked:
 * the second sees the first's delete and changes nothing.
 */
function keepsAnOwner(agentSlug: string) {
  const owners = db.select({ n: count() }).from(agentAcl)
    .where(and(eq(agentAcl.agentSlug, agentSlug), eq(agentAcl.role, 'owner')))
  return or(ne(agentAcl.role, 'owner'), gt(owners, 1))
}

/** Zero changes means the row is missing or the guard held; tell them apart for the caller's message. */
async function explainNoChange(agentSlug: string, userId: string): Promise<MemberWriteOutcome> {
  const member = await db.select({ id: agentAcl.id }).from(agentAcl)
    .where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, agentSlug))).get()
  return member ? 'last-owner' : 'not-a-member'
}

/** Change a member's role; an owner is demoted only while another owner remains. */
export async function changeMemberRole(agentSlug: string, userId: string, role: AgentRole): Promise<MemberWriteOutcome> {
  const result = await db.update(agentAcl).set({ role })
    .where(and(
      eq(agentAcl.userId, userId),
      eq(agentAcl.agentSlug, agentSlug),
      role === 'owner' ? undefined : keepsAnOwner(agentSlug),
    ))
    .run()
  return changesOf(result) > 0 ? 'done' : explainNoChange(agentSlug, userId)
}

/** Remove a member; an owner leaves only while another owner remains. */
export async function removeMember(agentSlug: string, userId: string): Promise<MemberWriteOutcome> {
  const result = await db.delete(agentAcl)
    .where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, agentSlug), keepsAnOwner(agentSlug)))
    .run()
  return changesOf(result) > 0 ? 'done' : explainNoChange(agentSlug, userId)
}

/**
 * Make users members of `agentSlug` with the `user` role, keeping any role a user already has there. With no `userIds`,
 * every user in the workspace.
 */
export async function addAgentUsers(agentSlug: string, userIds?: readonly string[]): Promise<void> {
  if (!isAuthMode()) return
  const ids = userIds ?? (await db.select({ id: user.id }).from(user).all()).map((row) => row.id)
  if (ids.length === 0) return
  const createdAt = new Date()
  await db.insert(agentAcl)
    .values(ids.map((userId) => ({ id: randomUUID(), userId, agentSlug, role: 'user' as const, createdAt })))
    .onConflictDoNothing()
  await notifyAgentMembersChanged(agentSlug)
}

/** Someone new to the workspace gets its Team Brain, as every member has it. */
export async function addTeamBrainUser(userId: string): Promise<void> {
  const teamBrain = getTeamBrain()
  if (teamBrain) await addAgentUsers(teamBrain.agentSlug, [userId])
}

export async function notifyAgentMembersChanged(agentSlug: string, removedUserId?: string): Promise<void> {
  if (!isAuthMode()) return
  try {
    const recipients = (await db.select({ id: agentAcl.userId }).from(agentAcl)
      .where(eq(agentAcl.agentSlug, agentSlug)).all()).map((row) => row.id)
    publishCollaborationEvent(recipients, { type: 'agent_members_changed', agentSlug })
    // Removed members still need a direct hint. Deployment admins retain
    // route access without an ACL entry, so only refresh their membership UI.
    if (removedUserId) {
      const removedUser = await db.select({ role: user.role }).from(user)
        .where(eq(user.id, removedUserId)).get()
      publishCollaborationEvent([removedUserId], {
        type: removedUser?.role === 'admin' ? 'agent_members_changed' : 'agent_access_revoked',
        agentSlug,
      })
    }
  } catch (error) {
    // The mutation already committed. Reconnect/focus refetches recover hints.
    console.error('Failed to notify agent members:', error)
  }
}

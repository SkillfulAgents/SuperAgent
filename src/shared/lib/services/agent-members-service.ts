import { asc, eq, inArray } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentAcl, user } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { agentMembersSchema } from '@shared/lib/agent-members-schema'
import { getUserImage } from '@shared/lib/user-profile-schema'
import { publishCollaborationEvent } from './collaboration-events'

export function listAgentMembers(agentSlug: string) {
  const rows = db.select({
    id: user.id, name: user.name, email: user.email, image: user.image,
    avatarOverride: user.avatarOverride, role: agentAcl.role,
  }).from(agentAcl).innerJoin(user, eq(agentAcl.userId, user.id))
    .where(eq(agentAcl.agentSlug, agentSlug))
    // Joining time + stable ID keep faces stationary when names or roles change.
    .orderBy(asc(agentAcl.createdAt), asc(user.id)).all()
  return agentMembersSchema.parse(rows.map(({ avatarOverride, ...row }) => ({
    ...row, image: getUserImage({ ...row, avatarOverride }),
  })))
}

export function notifyAgentMembersChanged(agentSlug: string, revokedUserId?: string): void {
  if (!isAuthMode()) return
  try {
    const recipients = db.select({ id: agentAcl.userId }).from(agentAcl)
      .where(eq(agentAcl.agentSlug, agentSlug)).all().map((row) => row.id)
    publishCollaborationEvent(recipients, { type: 'agent_members_changed', agentSlug })
    // The removed user no longer passes the usual agent audience filter.
    if (revokedUserId) publishCollaborationEvent([revokedUserId], { type: 'agent_access_revoked', agentSlug })
  } catch (error) {
    // The mutation already committed. Reconnect/focus refetches recover hints.
    console.error('Failed to notify agent members:', error)
  }
}

export function notifyUserProfileChanged(userId: string): void {
  if (!isAuthMode()) return
  try {
    const sharedAgents = db.select({ slug: agentAcl.agentSlug }).from(agentAcl)
      .where(eq(agentAcl.userId, userId)).all().map((row) => row.slug)
    const recipients = sharedAgents.length ? db.selectDistinct({ id: agentAcl.userId }).from(agentAcl)
      .where(inArray(agentAcl.agentSlug, sharedAgents)).all().map((row) => row.id) : []
    publishCollaborationEvent([userId, ...recipients], { type: 'user_profile_changed', userId })
  } catch (error) {
    console.error('Failed to notify profile change:', error)
  }
}

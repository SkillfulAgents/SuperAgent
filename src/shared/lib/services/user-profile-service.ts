import { and, eq, inArray, notInArray, or, sql, type AnyColumn } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { user } from '@shared/lib/db/schema'
import { getUserImage, type UserImageFields } from '@shared/lib/user-profile-schema'

const profileFields = {
  id: user.id, name: user.name, email: user.email,
  image: user.image, avatarOverride: user.avatarOverride,
}

type ProfileRow = Pick<typeof user.$inferSelect, keyof typeof profileFields>
export type UserSenderSource = { id: string; name: string } & UserImageFields

/** The existing live-message/typing summary intentionally excludes email. */
export function toUserSender(profile: UserSenderSource) {
  return { id: profile.id, name: profile.name, image: getUserImage(profile) }
}

function toUserProfile(profile: ProfileRow) {
  return { ...toUserSender(profile), email: profile.email }
}

/** Internal read API: callers authorize IDs through their agent/session first. */
export function getUserSummaries(userIds: readonly string[]) {
  const ids = [...new Set(userIds)]
  const profiles = ids.length
    ? db.select(profileFields).from(user).where(inArray(user.id, ids)).all()
    : []
  return new Map(profiles.map(profile => [profile.id, toUserProfile(profile)]))
}

export function userExists(userId: string): boolean {
  return !!db.select({ id: user.id }).from(user).where(eq(user.id, userId)).get()
}

/** Callers authorize directory access and supply users to exclude. */
export function searchUserSummaries(query: string | undefined, excludeIds: readonly string[]) {
  // SQLite LIKE is case-insensitive. Treat %, _ and backslash as literals.
  const escaped = query?.trim().replace(/[\\%_]/g, '\\$&') ?? ''
  const matchesQuery = (column: AnyColumn) =>
    sql`${column} LIKE ${`%${escaped}%`} ESCAPE '\\'`
  const profiles = db.select(profileFields).from(user).where(and(
    // Exclude before limiting, so existing members don't consume result slots.
    excludeIds.length ? notInArray(user.id, [...excludeIds]) : undefined,
    escaped ? or(matchesQuery(user.name), matchesQuery(user.email)) : undefined,
  )).limit(50).all()
  return profiles.map(toUserProfile)
}

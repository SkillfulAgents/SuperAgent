import { randomUUID } from 'node:crypto'
import { and, count, eq, exists, gt, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { changesOf, insertWhere } from '@shared/lib/db/batch'
import { user, volumeAcl, volumeDefinitions } from '@shared/lib/db/schema'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import { manageableVolumes, VolumeError, type VolumeViewer } from './volume-service'

function canShare(id: string, viewer: VolumeViewer) {
  if (!viewer.userId) return sql`0`
  return exists(db.select({ id: volumeDefinitions.id }).from(volumeDefinitions)
    .where(and(eq(volumeDefinitions.id, id), manageableVolumes(viewer))))
}

export async function requireVolumeManager(id: string, viewer: VolumeViewer) {
  if (!viewer.userId || !await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions)
    .where(and(eq(volumeDefinitions.id, id), manageableVolumes(viewer))).get()) {
    throw new VolumeError('Drive not found', 404)
  }
}

export async function volumeOwnerIds(id: string) {
  const rows = await db.select({ id: volumeAcl.userId }).from(volumeAcl).where(eq(volumeAcl.volumeId, id)).all()
  return rows.flatMap(row => row.id === null ? [] : [row.id])
}

export async function grantVolumeOwner(id: string, userId: string, viewer: VolumeViewer) {
  const result = await insertWhere(volumeAcl, { id: randomUUID(), volumeId: id, userId, role: 'owner', createdAt: new Date() },
    and(canShare(id, viewer), exists(db.select({ id: user.id }).from(user).where(eq(user.id, userId)))))
    .onConflictDoNothing().run()
  if (changesOf(result)) return
  await requireVolumeManager(id, viewer)
  if (!await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).get()) throw new VolumeError('Person not found', 404)
  throw new VolumeError('This person already owns the drive', 409)
}

export async function revokeVolumeOwner(id: string, userId: string, viewer: VolumeViewer) {
  const target = and(eq(volumeAcl.volumeId, id), eq(volumeAcl.userId, userId))
  const owners = db.select({ n: count() }).from(volumeAcl).where(and(eq(volumeAcl.volumeId, id), eq(volumeAcl.role, 'owner')))
  const result = await db.delete(volumeAcl).where(and(target, canShare(id, viewer), gt(owners, 1))).run()
  if (changesOf(result)) return
  await requireVolumeManager(id, viewer)
  if (await db.select({ id: volumeAcl.id }).from(volumeAcl).where(target).get()) {
    throw new VolumeError('Add another owner before removing the last owner', 409)
  }
  throw new VolumeError('Owner not found', 404)
}

/** Release all grants atomically before deleting any credentials. Concurrent removals
 * must leave the surviving owner able to sign in. A repeat after success has no grants to release. */
export async function releaseUserVolumeGrants(userId: string): Promise<boolean> {
  const mine = eq(volumeAcl.userId, userId)
  const result = await db.delete(volumeAcl).where(and(mine, sql`not exists (
    select 1 from volume_acl owned where owned.user_id = ${userId}
    and not exists (select 1 from volume_acl other where other.volume_id = owned.volume_id
      and other.id <> owned.id and other.role = 'owner')
  )`)).run()
  if (changesOf(result) > 0) {
    globalFeed.publish({ type: 'volume_access_changed' })
    return true
  }
  return !await db.select({ id: volumeAcl.id }).from(volumeAcl).where(mine).limit(1).get()
}

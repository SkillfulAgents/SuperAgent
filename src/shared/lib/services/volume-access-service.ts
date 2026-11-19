import { randomUUID } from 'node:crypto'
import { and, count, eq, exists, gt, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch, changesOf, insertWhere } from '@shared/lib/db/batch'
import { auditLog, user, volumeAcl, volumeDefinitions } from '@shared/lib/db/schema'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import { manageableVolumes, VolumeError, type VolumeViewer } from './volume-service'

function canShare(id: string, viewer: VolumeViewer) {
  if (!viewer.userId) return sql`0`
  return exists(db.select({ id: volumeDefinitions.id }).from(volumeDefinitions)
    .where(and(eq(volumeDefinitions.id, id), manageableVolumes(viewer))))
}

export async function requireVolumeManager(id: string, viewer: VolumeViewer) {
  const drive = viewer.userId && await db.select({ name: volumeDefinitions.name }).from(volumeDefinitions)
    .where(and(eq(volumeDefinitions.id, id), manageableVolumes(viewer))).get()
  if (!drive) throw new VolumeError('Drive not found', 404)
  return drive
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

/** The removing admin inherits only drives that would lose their last owner.
 * The batch serializes concurrent removals and can run again for the next auth hook. */
export async function releaseUserVolumeGrants(userId: string, adminId: string): Promise<void> {
  const soleGrants = sql`from volume_acl owned where owned.user_id = ${userId}
    and not exists (select 1 from volume_acl other where other.volume_id = owned.volume_id and other.id <> owned.id)`
  const now = Date.now()
  const [, , removed] = await batch([
    db.insert(auditLog).select(sql`select lower(hex(randomblob(16))), ${now}, ${adminId}, 'volume', owned.volume_id, 'granted',
      json_object('targetUserId', ${adminId}, 'previousOwnerId', ${userId}, 'role', 'owner') ${soleGrants}`),
    db.insert(volumeAcl).select(sql`select lower(hex(randomblob(16))), owned.volume_id, ${adminId}, 'owner', ${now} ${soleGrants}`),
    db.delete(volumeAcl).where(eq(volumeAcl.userId, userId)),
  ])
  if (changesOf(removed)) globalFeed.publish({ type: 'volume_access_changed' })
}

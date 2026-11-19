import { randomUUID } from 'node:crypto'
import { and, asc, eq, exists, isNull, ne, notExists, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { batch, changesOf, insertWhere } from '@shared/lib/db/batch'
import { SETTINGS_RECORD_KEY } from '@shared/lib/app-records/record-schemas'
import { appRecords, agentVolumes, volumeAcl, volumeDefinitions, user } from '@shared/lib/db/schema'
import { VOLUME_TYPES, type StoredVolume, type VolumeDefinitionSummary, type VolumeOwner } from '@shared/lib/types/mount'
import { instantiateVolume, prepareVolume, removeVolume, sourceKey } from '@shared/lib/volumes/volume-factory'
import { localVolumeConfigSchema, volumeConfigSchema } from '@shared/lib/volumes/volume-config-schema'
import { prepareLocalVolume } from '@shared/lib/volumes/local-mountable-volume'
import { volumeHealth, volumeProblem, volumeSummary } from '@shared/lib/volumes/volume-health'
import { VolumeError } from '@shared/lib/volumes/volume-error'
import { createVolumeSchema, updateVolumeSchema, volumeNameSchema } from './mount-schema'
import { toUserProfile, userProfileFields } from './user-profile-service'

export type VolumeViewer = { userId: string | null; admin: boolean }
export type VolumeRow = typeof volumeDefinitions.$inferSelect

export { VolumeError } from '@shared/lib/volumes/volume-error'

function ownsVolume(viewer: VolumeViewer) {
  return viewer.userId ? exists(db.select({ id: volumeAcl.id }).from(volumeAcl)
    .where(and(eq(volumeAcl.volumeId, volumeDefinitions.id), eq(volumeAcl.userId, viewer.userId), eq(volumeAcl.role, 'owner')))) : undefined
}

export function selectableVolumes(viewer: VolumeViewer) {
  return or(eq(volumeDefinitions.visibility, 'public'), ownsVolume(viewer))
}

export function manageableVolumes(viewer: VolumeViewer) {
  return or(viewer.admin ? eq(volumeDefinitions.visibility, 'public') : undefined, ownsVolume(viewer)) ?? sql`0`
}

/** Refuses a drive the viewer can't manage before any work for it. Its write still checks, with the change. */
export async function assertManageableVolume(id: string, viewer: VolumeViewer): Promise<void> {
  const row = await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(and(eq(volumeDefinitions.id, id), manageableVolumes(viewer))).get()
  if (!row) throw new VolumeError('Drive not found', 404)
}

/** Bad/future configurations are kept in SQLite; they cannot become usable mounts. */
export function storedDefinition(row: Pick<VolumeRow, 'id' | 'name' | 'type' | 'config'>): StoredVolume | null {
  const type = z.enum(VOLUME_TYPES).safeParse(row.type)
  if (!type.success) return null
  let config: unknown = null
  try {
    config = volumeConfigSchema.parse({ type: type.data, config: JSON.parse(row.config) }).config
  } catch (error) {
    console.warn(`[volumes] Invalid configuration for ${row.id}; keeping the volume unavailable:`, error)
  }
  return { id: row.id, name: row.name, type: type.data, config }
}

function requirePrivateDriveOwner(visibility: VolumeRow['visibility'] | undefined, viewer: VolumeViewer) {
  if (visibility === 'private' && !viewer.userId) throw new VolumeError('Private drives require a signed-in user', 400)
}

export async function prepareVolumeDefinition(raw: unknown, viewer: VolumeViewer): Promise<VolumeRow> {
  const input = createVolumeSchema.parse(raw)
  const visibility = input.visibility ?? (viewer.userId ? 'private' : 'public')
  requirePrivateDriveOwner(visibility, viewer)
  if (visibility === 'public' && !viewer.admin) throw new VolumeError('Only admins can publish drives', 403)
  let prepared: Awaited<ReturnType<typeof prepareVolume>>
  try {
    prepared = await prepareVolume(input.type, input.config, viewer)
  } catch (error) {
    if (error instanceof VolumeError) throw error
    throw new VolumeError(error instanceof Error ? error.message : 'Invalid drive configuration', 400)
  }
  const config = volumeConfigSchema.parse(prepared).config
  const now = new Date()
  return {
    id: randomUUID(), createdBy: viewer.userId, visibility, name: volumeNameSchema.parse(input.name ?? prepared.name),
    type: prepared.type, config: JSON.stringify(config), globalAccess: null, createdAt: now, updatedAt: now,
  }
}

/**
 * A working drive the viewer can see on `row`'s source, to use instead of making `row`; a broken one is passed over,
 * so adding its source again still repairs it. Shared asked of a private drive is refused, not changed. A new pick
 * of a local drive's folder gives it the pick's bookmark, which opens the folder after a restart where the saved one may not.
 */
export async function reusableVolume(row: VolumeRow, viewer: VolumeViewer): Promise<VolumeRow | null> {
  const stored = storedDefinition(row)
  const key = stored && sourceKey(stored)
  if (!key) return null
  const rows = await db.select().from(volumeDefinitions).where(and(eq(volumeDefinitions.type, row.type), selectableVolumes(viewer)))
    .orderBy(asc(volumeDefinitions.createdAt), asc(volumeDefinitions.id)).all()
  const usable = (await Promise.all(rows.map(async candidate => {
    const stored = storedDefinition(candidate)
    if (!stored || sourceKey(stored) !== key) return null
    return volumeHealth(await volumeProblem(stored)) === 'missing' ? null : candidate
  }))).filter(candidate => candidate !== null)
  const match = usable.find(candidate => candidate.visibility === row.visibility) ?? usable[0]
  if (!match) return null
  if (row.visibility === 'public' && match.visibility === 'private') {
    throw new VolumeError(`This folder is already your private drive ${match.name}. Share it from Settings → Drives, or add it from Saved drives.`, 409)
  }
  const pick = localVolumeConfigSchema.safeParse(stored.config)
  if (row.type === 'local' && pick.success && pick.data.bookmark && pick.data.bookmark !== localVolumeConfigSchema.safeParse(storedDefinition(match)?.config).data?.bookmark) {
    // Only helps the next launch, so a refusal (another's drive, a concurrent pick) never fails this add.
    await reconnectLocalVolume(match.id, pick.data, viewer).catch(error => { if (!(error instanceof VolumeError)) throw error })
  }
  return match
}

/** A source that already has a drive the viewer can see gives that drive back, `reused`. */
export async function createVolumeDefinition(raw: unknown, viewer: VolumeViewer): Promise<{ id: string; reused: boolean }> {
  const row = await prepareVolumeDefinition(raw, viewer)
  const match = await reusableVolume(row, viewer)
  if (match) return { id: match.id, reused: true }
  await db.insert(volumeDefinitions).values(row).run()
  return { id: row.id, reused: false }
}

// An uncorrelated scalar subquery reads the designation once per statement.
function teamBrainDriveId() {
  return sql<string | null>`(select json_extract(${appRecords.value}, '$.teamBrain.volumeId')
    from ${appRecords} where ${appRecords.key} = ${SETTINGS_RECORD_KEY} and json_valid(${appRecords.value}))`
}

export async function listVolumeDefinitions(viewer: VolumeViewer): Promise<VolumeDefinitionSummary[]> {
  const rows = await db.select({
    volume: volumeDefinitions, teamBrainDriveId: teamBrainDriveId(),
    attachmentCount: db.$count(agentVolumes, eq(agentVolumes.volumeId, volumeDefinitions.id)),
    owner: userProfileFields(), role: volumeAcl.role,
  }).from(volumeDefinitions)
    .innerJoin(volumeAcl, eq(volumeAcl.volumeId, volumeDefinitions.id))
    .leftJoin(user, eq(user.id, volumeAcl.userId))
    .where(selectableVolumes(viewer))
    .orderBy(asc(volumeDefinitions.createdAt), asc(volumeDefinitions.id), asc(volumeAcl.createdAt), asc(volumeAcl.id)).all()
  const volumes = new Map<string, { volume: VolumeRow; attachmentCount: number; owners: VolumeOwner[] }>()
  for (const { volume, attachmentCount, owner, role } of rows) {
    const entry = volumes.get(volume.id) ?? { volume, attachmentCount, owners: [] }
    if (owner) {
      const { id, ...profile } = toUserProfile(owner)
      entry.owners.push({ userId: id, ...profile, role })
    } else {
      entry.owners.push({ userId: null, name: 'Workspace admins', role })
    }
    volumes.set(volume.id, entry)
  }
  const brainDrive = rows[0]?.teamBrainDriveId
  const summaries = await Promise.all([...volumes.values()].map(async ({ volume, attachmentCount, owners }) => {
    const stored = storedDefinition(volume)
    if (!stored) return null
    // The health check loads the drive's state first, so the summary's attention line reads it.
    const problem = await volumeProblem(stored)
    return {
      health: volumeHealth(problem),
      ...volumeSummary(stored),
      ...(problem === 'pick the folder again' ? { pickFolderAgain: true as const } : {}),
      visibility: volume.visibility, owners,
      // Older desktop clients use this field to distinguish public and private.
      userId: volume.visibility === 'public' ? null : owners[0].userId,
      canManage: (volume.visibility === 'public' && viewer.admin) || owners.some(owner => owner.userId !== null && owner.userId === viewer.userId),
      attachmentCount,
      globalAccess: volume.globalAccess,
      ...(volume.id === brainDrive ? { teamBrainDrive: true as const } : {}),
    }
  }))
  return summaries.filter(row => row !== null)
}

export async function updateVolumeDefinition(id: string, raw: unknown, viewer: VolumeViewer): Promise<void> {
  const input = updateVolumeSchema.parse(raw)
  const ownership = and(eq(volumeDefinitions.id, id), manageableVolumes(viewer))
  requirePrivateDriveOwner(input.visibility, viewer)
  if (input.global && input.visibility === 'private') throw new VolumeError('Only public drives can be global', 400)
  const allowed = and(ownership,
    input.visibility && !viewer.admin ? eq(volumeDefinitions.visibility, input.visibility) : undefined,
    input.global !== undefined && !viewer.admin ? sql`0` : undefined,
    input.global && input.visibility !== 'public' ? eq(volumeDefinitions.visibility, 'public') : undefined,
    input.visibility === 'private' ? and(isNull(volumeDefinitions.globalAccess), sql`${volumeDefinitions.id} is not ${teamBrainDriveId()}`) : undefined)
  const update = db.update(volumeDefinitions).set({ name: input.name, visibility: input.visibility, globalAccess: input.global, updatedAt: new Date() }).where(allowed)
  // The admin making a public drive private becomes an owner in the same batch, including
  // legacy drives whose only owner is the workspace. A rejected change grants nothing.
  const result = input.visibility === 'private' && viewer.userId
    ? (await batch([
      insertWhere(volumeAcl, { id: randomUUID(), volumeId: id, userId: viewer.userId, role: 'owner', createdAt: new Date() },
        exists(db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(and(allowed, eq(volumeDefinitions.visibility, 'public')))))
        .onConflictDoNothing(),
      update,
    ]))[1]
    : await update.run()
  if (changesOf(result) > 0) return
  const existing = await db.select({ visibility: volumeDefinitions.visibility, globalAccess: volumeDefinitions.globalAccess, teamBrainDriveId: teamBrainDriveId() }).from(volumeDefinitions).where(ownership).get()
  if (existing) {
    if (input.visibility && !viewer.admin && input.visibility !== existing.visibility) throw new VolumeError('Only admins can change drive visibility', 403)
    if (input.global && existing.visibility !== 'public') throw new VolumeError('Only public drives can be global', 400)
    if (input.global !== undefined && !viewer.admin) throw new VolumeError('Only admins can change global access', 403)
    if (input.visibility === 'private' && id === existing.teamBrainDriveId) throw new VolumeError('Team Brain requires a public drive', 409)
    if (input.visibility === 'private' && existing.globalAccess) throw new VolumeError('Turn off global before changing access', 409)
    throw new VolumeError('Drive access changed. Try again.', 409)
  }
  throw new VolumeError('Drive not found', 404)
}

/**
 * Gives a local drive its folder again from a new pick in the open panel,
 * keeping the drive's id and so every agent that has it. The Mac App Store
 * build reads the folder only through the pick's bookmark, and a bookmark can
 * stop opening it (the folder deleted and made again, the disk erased). The
 * same folder only: another one is a new drive, since agents' mounts lead here.
 */
export async function reconnectLocalVolume(id: string, raw: unknown, viewer: VolumeViewer): Promise<void> {
  const ownership = and(eq(volumeDefinitions.id, id), manageableVolumes(viewer))
  const row = await db.select().from(volumeDefinitions).where(ownership).get()
  if (!row) throw new VolumeError('Drive not found', 404)
  const stored = storedDefinition(row)
  if (stored?.type !== 'local') throw new VolumeError('Only a local folder’s drive can have its folder chosen again', 400)
  const current = localVolumeConfigSchema.safeParse(stored.config)
  if (!current.success) throw new VolumeError('Drive configuration is unavailable', 400)
  const input = localVolumeConfigSchema.strict().parse(raw)
  let prepared: Awaited<ReturnType<typeof prepareLocalVolume>>
  try {
    prepared = await prepareLocalVolume(input)
  } catch (error) {
    if (error instanceof VolumeError) throw error
    throw new VolumeError(error instanceof Error ? error.message : 'Invalid drive configuration', 400)
  }
  if (prepared.config.path !== current.data.path) {
    throw new VolumeError(`Choose this drive’s own folder, ${current.data.path}. Add another folder as a new drive.`, 400)
  }
  const config = volumeConfigSchema.parse({ type: 'local', config: prepared.config }).config
  // Unchanged since it was read, so a second pick racing this one can't be overwritten unseen.
  const result = await db.update(volumeDefinitions).set({ config: JSON.stringify(config), updatedAt: new Date() })
    .where(and(ownership, eq(volumeDefinitions.config, row.config))).run()
  if (changesOf(result) > 0) return
  if (await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(ownership).get()) {
    throw new VolumeError('The drive changed while its folder was chosen. Try again.', 409)
  }
  throw new VolumeError('Drive not found', 404)
}

export async function deleteVolumeDefinition(id: string, viewer: VolumeViewer): Promise<void> {
  const ownership = and(eq(volumeDefinitions.id, id), manageableVolumes(viewer))
  const rows = await db.delete(volumeDefinitions).where(and(ownership,
    notExists(db.select({ id: agentVolumes.id }).from(agentVolumes).where(eq(agentVolumes.volumeId, id))),
  )).returning({ type: volumeDefinitions.type }).all()
  if (rows.length > 0) {
    await removeVolume(rows[0].type, id)
    return
  }
  if (await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(ownership).get()) {
    throw new VolumeError('Remove this drive from all agents before deleting it', 409)
  }
  throw new VolumeError('Drive not found', 404)
}

/** Whether every member can add the drive: it is public in this workspace. */
export async function isPublicVolume(id: string): Promise<boolean> {
  const row = await db.select({ visibility: volumeDefinitions.visibility }).from(volumeDefinitions).where(eq(volumeDefinitions.id, id)).get()
  return row?.visibility === 'public'
}

/** User-facing access to a source, independent of any agent or running container. */
export async function getVisibleVolumeDefinition(id: string, viewer: VolumeViewer): Promise<StoredVolume> {
  const row = await db.select().from(volumeDefinitions)
    .where(and(eq(volumeDefinitions.id, id), selectableVolumes(viewer))).get()
  if (!row) throw new VolumeError('Drive not found', 404)
  const stored = storedDefinition(row)
  if (!stored) throw new VolumeError('Drive configuration is unavailable', 400)
  return stored
}

export async function openVolumeDefinition(id: string, viewer: VolumeViewer) {
  const volume = instantiateVolume(await getVisibleVolumeDefinition(id, viewer))
  if (!volume) throw new VolumeError('Drive configuration is unavailable', 400)
  return volume
}

/**
 * Takes a drive off every agent but `keep` and clears its global access. Checks no viewer: the caller authorizes first.
 */
export async function releaseVolume(id: string, keep: string): Promise<void> {
  const where = and(eq(agentVolumes.volumeId, id), ne(agentVolumes.agentSlug, keep))
  await batch([
    db.delete(agentVolumes).where(where),
    db.update(volumeDefinitions).set({ globalAccess: null, updatedAt: new Date() }).where(eq(volumeDefinitions.id, id)),
  ])
}

export async function listVolumeAttachments(id: string, viewer: VolumeViewer) {
  await getVisibleVolumeDefinition(id, viewer)
  return db.select({ agentSlug: agentVolumes.agentSlug, mountId: agentVolumes.id })
    .from(agentVolumes).where(eq(agentVolumes.volumeId, id)).all()
}

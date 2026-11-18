import { randomUUID } from 'node:crypto'
import { and, asc, eq, exists, isNull, ne, notExists, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { batch, changesOf, insertWhere } from '@shared/lib/db/batch'
import { agentVolumes, volumeAcl, volumeDefinitions, user } from '@shared/lib/db/schema'
import { VOLUME_TYPES, type StoredVolume, type VolumeDefinitionSummary, type VolumeOwner } from '@shared/lib/types/mount'
import { instantiateVolume, prepareVolume, removeVolume } from '@shared/lib/volumes/volume-factory'
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

function checkVisibility(visibility: 'public' | 'private', viewer: VolumeViewer) {
  if (visibility === 'public' && !viewer.admin) throw new VolumeError('Only admins can publish drives', 403)
  if (visibility === 'private' && !viewer.userId) throw new VolumeError('Private drives require a signed-in user', 400)
}

export async function prepareVolumeDefinition(raw: unknown, viewer: VolumeViewer): Promise<VolumeRow> {
  const input = createVolumeSchema.parse(raw)
  const visibility = input.visibility ?? (viewer.userId ? 'private' : 'public')
  checkVisibility(visibility, viewer)
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

export async function createVolumeDefinition(raw: unknown, viewer: VolumeViewer): Promise<string> {
  const row = await prepareVolumeDefinition(raw, viewer)
  await db.insert(volumeDefinitions).values(row).run()
  return row.id
}

export async function listVolumeDefinitions(viewer: VolumeViewer): Promise<VolumeDefinitionSummary[]> {
  const rows = await db.select({
    volume: volumeDefinitions,
    attachmentCount: db.$count(agentVolumes, eq(agentVolumes.volumeId, volumeDefinitions.id)),
    owner: userProfileFields, role: volumeAcl.role,
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
    }
  }))
  return summaries.filter(row => row !== null)
}

export async function updateVolumeDefinition(id: string, raw: unknown, viewer: VolumeViewer): Promise<void> {
  const input = updateVolumeSchema.parse(raw)
  const ownership = and(eq(volumeDefinitions.id, id), manageableVolumes(viewer))
  if (input.visibility) checkVisibility(input.visibility, viewer)
  if (input.global && input.visibility === 'private') throw new VolumeError('Only public drives can be global', 400)
  const allowed = and(ownership,
    input.global !== undefined && !viewer.admin ? sql`0` : undefined,
    input.global && input.visibility !== 'public' ? eq(volumeDefinitions.visibility, 'public') : undefined,
    input.visibility === 'private' ? isNull(volumeDefinitions.globalAccess) : undefined)
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
  const existing = await db.select({ visibility: volumeDefinitions.visibility, globalAccess: volumeDefinitions.globalAccess }).from(volumeDefinitions).where(ownership).get()
  if (existing) {
    if (input.global && existing.visibility !== 'public') throw new VolumeError('Only public drives can be global', 400)
    if (input.global !== undefined && !viewer.admin) throw new VolumeError('Only admins can change global access', 403)
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
 * Returns the agents it came off, read just before the delete, so a drive added in between is removed but not listed.
 */
export async function releaseVolume(id: string, keep: string): Promise<string[]> {
  const where = and(eq(agentVolumes.volumeId, id), ne(agentVolumes.agentSlug, keep))
  const attached = await db.select({ agentSlug: agentVolumes.agentSlug }).from(agentVolumes).where(where).all()
  await batch([
    db.delete(agentVolumes).where(where),
    db.update(volumeDefinitions).set({ globalAccess: null, updatedAt: new Date() }).where(eq(volumeDefinitions.id, id)),
  ])
  return attached.map((row) => row.agentSlug)
}

export async function listVolumeAttachments(id: string, viewer: VolumeViewer) {
  await getVisibleVolumeDefinition(id, viewer)
  return db.select({ agentSlug: agentVolumes.agentSlug, mountId: agentVolumes.id })
    .from(agentVolumes).where(eq(agentVolumes.volumeId, id)).all()
}

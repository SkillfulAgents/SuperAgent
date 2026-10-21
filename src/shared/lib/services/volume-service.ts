import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNull, ne, notExists, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { batch, changesOf } from '@shared/lib/db/batch'
import { agentVolumes, volumeDefinitions } from '@shared/lib/db/schema'
import { VOLUME_TYPES, type StoredVolume, type VolumeDefinitionSummary } from '@shared/lib/types/mount'
import { instantiateVolume, prepareVolume, removeVolume } from '@shared/lib/volumes/volume-factory'
import { volumeConfigSchema } from '@shared/lib/volumes/volume-config-schema'
import { volumeHealth, volumeProblem, volumeSummary } from '@shared/lib/volumes/volume-health'
import { VolumeError } from '@shared/lib/volumes/volume-error'
import { createVolumeSchema, updateVolumeSchema, volumeNameSchema } from './mount-schema'

export type VolumeViewer = { userId: string | null; admin: boolean }
export type VolumeRow = typeof volumeDefinitions.$inferSelect

export { VolumeError } from '@shared/lib/volumes/volume-error'

export function selectableVolumes(viewer: VolumeViewer) {
  return or(isNull(volumeDefinitions.userId), ...(viewer.userId ? [eq(volumeDefinitions.userId, viewer.userId)] : []))
}

function manageableVolumes(viewer: VolumeViewer) {
  return or(
    ...(viewer.admin ? [isNull(volumeDefinitions.userId)] : []),
    ...(viewer.userId ? [eq(volumeDefinitions.userId, viewer.userId)] : []),
  ) ?? sql`0`
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

function ownerFor(visibility: 'public' | 'private' | undefined, viewer: VolumeViewer): string | null {
  if (visibility === 'public' || (visibility === undefined && viewer.userId === null)) {
    if (!viewer.admin) throw new VolumeError('Only admins can create public drives', 403)
    return null
  }
  if (viewer.userId === null) throw new VolumeError('Private drives require a signed-in user', 400)
  return viewer.userId
}

export async function prepareVolumeDefinition(raw: unknown, viewer: VolumeViewer): Promise<VolumeRow> {
  const input = createVolumeSchema.parse(raw)
  const userId = ownerFor(input.visibility, viewer)
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
    id: randomUUID(), userId, name: volumeNameSchema.parse(input.name ?? prepared.name),
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
  }).from(volumeDefinitions).where(selectableVolumes(viewer)).orderBy(asc(volumeDefinitions.createdAt), asc(volumeDefinitions.id)).all()
  const summaries = await Promise.all(rows.map(async ({ volume, attachmentCount }) => {
    const stored = storedDefinition(volume)
    if (!stored) return null
    return {
      // The health check loads the drive's state first, so the summary's attention line reads it.
      health: volumeHealth(await volumeProblem(stored)),
      ...volumeSummary(stored),
      userId: volume.userId,
      canManage: volume.userId === null ? viewer.admin : volume.userId === viewer.userId,
      attachmentCount,
      globalAccess: volume.globalAccess,
    }
  }))
  return summaries.filter(row => row !== null)
}

export async function updateVolumeDefinition(id: string, raw: unknown, viewer: VolumeViewer): Promise<void> {
  const input = updateVolumeSchema.parse(raw)
  const ownership = and(eq(volumeDefinitions.id, id), manageableVolumes(viewer))
  const userId = input.visibility === undefined ? undefined : ownerFor(input.visibility, viewer)
  if (input.global && typeof userId === 'string') throw new VolumeError('Only public drives can be global', 400)
  // Evaluate attachment and global state with the write, including races with attachment.
  const result = await db.update(volumeDefinitions).set({ name: input.name, userId, globalAccess: input.global, updatedAt: new Date() })
    .where(and(ownership, userId === undefined ? undefined : or(
      userId === null ? isNull(volumeDefinitions.userId) : eq(volumeDefinitions.userId, userId),
      notExists(db.select({ id: agentVolumes.id }).from(agentVolumes).where(eq(agentVolumes.volumeId, id))),
    ), input.global && userId === undefined ? isNull(volumeDefinitions.userId) : undefined,
    typeof userId === 'string' ? isNull(volumeDefinitions.globalAccess) : undefined)).run()
  if (changesOf(result) > 0) return
  const existing = await db.select({ userId: volumeDefinitions.userId, globalAccess: volumeDefinitions.globalAccess }).from(volumeDefinitions).where(ownership).get()
  if (existing) {
    if (input.global && existing.userId !== null) throw new VolumeError('Only public drives can be global', 400)
    if (typeof userId === 'string' && existing.globalAccess) throw new VolumeError('Turn off global before changing access', 409)
    throw new VolumeError('Remove this drive from all agents before changing its access', 409)
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

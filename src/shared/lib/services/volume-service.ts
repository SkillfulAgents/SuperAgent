import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNull, notExists, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { agentVolumes, volumeDefinitions } from '@shared/lib/db/schema'
import { VOLUME_TYPES, type StoredVolume, type VolumeDefinitionSummary } from '@shared/lib/types/mount'
import { prepareVolume } from '@shared/lib/volumes/volume-factory'
import { volumeConfigSchema } from '@shared/lib/volumes/volume-config-schema'
import { volumeProblem, volumeSummary } from '@shared/lib/volumes/volume-health'
import { createVolumeSchema, updateVolumeSchema, volumeNameSchema } from './mount-schema'

export type VolumeViewer = { userId: string | null; admin: boolean }
export type VolumeRow = typeof volumeDefinitions.$inferSelect

export class VolumeError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message)
    this.name = 'VolumeError'
  }
}

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
    if (!viewer.admin) throw new VolumeError('Only admins can create public volumes', 403)
    return null
  }
  if (viewer.userId === null) throw new VolumeError('Private volumes require a signed-in user', 400)
  return viewer.userId
}

export async function prepareVolumeDefinition(raw: unknown, viewer: VolumeViewer): Promise<VolumeRow> {
  const input = createVolumeSchema.parse(raw)
  const userId = ownerFor(input.visibility, viewer)
  let prepared: Awaited<ReturnType<typeof prepareVolume>>
  try {
    prepared = await prepareVolume(input.type, input.config, viewer)
  } catch (error) {
    throw new VolumeError(error instanceof Error ? error.message : 'Invalid volume configuration', 400)
  }
  const config = volumeConfigSchema.parse(prepared).config
  const now = new Date()
  return {
    id: randomUUID(), userId, name: volumeNameSchema.parse(input.name ?? prepared.name),
    type: prepared.type, config: JSON.stringify(config), createdAt: now, updatedAt: now,
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
      ...volumeSummary(stored),
      health: await volumeProblem(stored) === null ? 'ok' as const : 'missing' as const,
      userId: volume.userId,
      canManage: volume.userId === null ? viewer.admin : volume.userId === viewer.userId,
      attachmentCount,
    }
  }))
  return summaries.filter(row => row !== null)
}

export async function updateVolumeDefinition(id: string, raw: unknown, viewer: VolumeViewer): Promise<void> {
  const input = updateVolumeSchema.parse(raw)
  const ownership = and(eq(volumeDefinitions.id, id), manageableVolumes(viewer))
  const userId = input.visibility === undefined ? undefined : ownerFor(input.visibility, viewer)
  // Evaluate attachment state with the write, including races with attachment.
  const result = await db.update(volumeDefinitions).set({ name: input.name, userId, updatedAt: new Date() })
    .where(and(ownership, userId === undefined ? undefined : or(
      userId === null ? isNull(volumeDefinitions.userId) : eq(volumeDefinitions.userId, userId),
      notExists(db.select({ id: agentVolumes.id }).from(agentVolumes).where(eq(agentVolumes.volumeId, id))),
    ))).run()
  if (changesOf(result) > 0) return
  if (await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(ownership).get()) {
    throw new VolumeError('Detach this volume from all agents before changing its access', 409)
  }
  throw new VolumeError('Volume not found', 404)
}

export async function deleteVolumeDefinition(id: string, viewer: VolumeViewer): Promise<void> {
  const ownership = and(eq(volumeDefinitions.id, id), manageableVolumes(viewer))
  const result = await db.delete(volumeDefinitions).where(and(ownership,
    notExists(db.select({ id: agentVolumes.id }).from(agentVolumes).where(eq(agentVolumes.volumeId, id))),
  )).run()
  if (changesOf(result) > 0) return
  if (await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(ownership).get()) {
    throw new VolumeError('Detach this volume from all agents before deleting it', 409)
  }
  throw new VolumeError('Volume not found', 404)
}

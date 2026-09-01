import { randomUUID } from 'crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentAcl, agentSharedVolumes, sharedVolumes, type SharedVolume } from '@shared/lib/db/schema'
import { getVolumeDir } from '@shared/lib/config/data-dir'
import { isAuthMode } from '@shared/lib/auth/mode'
import { hasMinRole, type AgentRole } from '@shared/lib/types/agent'
import {
  ensureDirectory,
  nameToSlugBase,
  readAgentDisplayNameSync,
  removeDirectory,
} from '@shared/lib/utils/file-storage'

// Measured 2026-08-31: 19 worst-case entries keep the post-mTLS run-hook payload at 4083 bytes.
export const MAX_SHARED_VOLUMES_PER_AGENT = 19

const MOUNT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export class SharedVolumeError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409,
  ) {
    super(message)
    this.name = 'SharedVolumeError'
  }
}

function validateMountName(mountName: string): void {
  if (!mountName || !MOUNT_NAME_RE.test(mountName)) {
    throw new SharedVolumeError('Name must produce a path like /volumes/team-brain', 400)
  }
}

export async function createSharedVolume(name: string): Promise<SharedVolume> {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new SharedVolumeError('Name is required', 400)
  }
  const mountName = nameToSlugBase(trimmed)
  validateMountName(mountName)

  const existing = db
    .select({ id: sharedVolumes.id })
    .from(sharedVolumes)
    .where(sql`lower(${sharedVolumes.mountName}) = ${mountName}`)
    .get()
  if (existing) {
    throw new SharedVolumeError('A shared volume with this name already exists', 400)
  }

  const row: SharedVolume = {
    id: randomUUID(),
    name: trimmed,
    mountName,
    createdAt: new Date(),
  }
  db.insert(sharedVolumes).values(row).run()
  try {
    await ensureDirectory(getVolumeDir(row.id))
  } catch (error) {
    db.delete(sharedVolumes).where(eq(sharedVolumes.id, row.id)).run()
    throw error
  }
  return row
}

export function listSharedVolumes(): Array<SharedVolume & { attachedAgents: { slug: string; name: string }[] }> {
  const volumes = db.select().from(sharedVolumes).all()
  const junctions = db.select().from(agentSharedVolumes).all()
  const byVolume = new Map<string, { slug: string; name: string }[]>()
  for (const junction of junctions) {
    const list = byVolume.get(junction.volumeId) ?? []
    list.push({
      slug: junction.agentSlug,
      name: readAgentDisplayNameSync(junction.agentSlug) ?? junction.agentSlug,
    })
    byVolume.set(junction.volumeId, list)
  }
  return volumes.map((volume) => ({
    ...volume,
    attachedAgents: byVolume.get(volume.id) ?? [],
  }))
}

export function attachSharedVolume(agentSlug: string, volumeId: string): void {
  const volume = db.select().from(sharedVolumes).where(eq(sharedVolumes.id, volumeId)).get()
  if (!volume) {
    throw new SharedVolumeError('Shared volume not found', 404)
  }
  const attached = db
    .select({ id: agentSharedVolumes.id })
    .from(agentSharedVolumes)
    .where(eq(agentSharedVolumes.agentSlug, agentSlug))
    .all()
  if (attached.length >= MAX_SHARED_VOLUMES_PER_AGENT) {
    throw new SharedVolumeError(
      `This agent already has the maximum of ${MAX_SHARED_VOLUMES_PER_AGENT} shared volumes`,
      409,
    )
  }
  try {
    db.insert(agentSharedVolumes)
      .values({
        id: randomUUID(),
        agentSlug,
        volumeId,
        createdAt: new Date(),
      })
      .run()
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      throw new SharedVolumeError('This agent is already attached to that shared volume', 409)
    }
    throw error
  }
}

export function detachSharedVolume(agentSlug: string, volumeId: string): void {
  db.delete(agentSharedVolumes)
    .where(and(eq(agentSharedVolumes.agentSlug, agentSlug), eq(agentSharedVolumes.volumeId, volumeId)))
    .run()
}

function callerCanUseAgent(caller: { userId: string | null; isAdmin: boolean }, agentSlug: string): boolean {
  if (!isAuthMode() || caller.isAdmin) return true
  if (!caller.userId) return false
  const row = db
    .select({ role: agentAcl.role })
    .from(agentAcl)
    .where(and(eq(agentAcl.userId, caller.userId), eq(agentAcl.agentSlug, agentSlug)))
    .get()
  return hasMinRole((row?.role ?? null) as AgentRole | null, 'user')
}

export async function deleteSharedVolume(
  volumeId: string,
  caller: { userId: string | null; isAdmin: boolean },
): Promise<void> {
  const volume = db.select().from(sharedVolumes).where(eq(sharedVolumes.id, volumeId)).get()
  if (!volume) {
    throw new SharedVolumeError('Shared volume not found', 404)
  }
  const attachments = db
    .select()
    .from(agentSharedVolumes)
    .where(eq(agentSharedVolumes.volumeId, volumeId))
    .all()
  if (attachments.length > 1) {
    throw new SharedVolumeError('Volume is attached to other agents', 409)
  }
  if (attachments.length === 1 && !callerCanUseAgent(caller, attachments[0].agentSlug)) {
    throw new SharedVolumeError('Volume is attached to other agents', 409)
  }

  db.delete(sharedVolumes).where(eq(sharedVolumes.id, volumeId)).run()
  try {
    await removeDirectory(getVolumeDir(volumeId))
  } catch (error) {
    console.error('[shared-volume] failed to remove volume directory', { volumeId, error })
  }
}

export function getAgentSharedVolumes(agentSlug: string): Array<{ id: string; mountName: string }> {
  return db
    .select({
      id: sharedVolumes.id,
      mountName: sharedVolumes.mountName,
    })
    .from(agentSharedVolumes)
    .innerJoin(sharedVolumes, eq(agentSharedVolumes.volumeId, sharedVolumes.id))
    .where(eq(agentSharedVolumes.agentSlug, agentSlug))
    .all()
}

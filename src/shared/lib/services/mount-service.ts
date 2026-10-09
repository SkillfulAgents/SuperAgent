import { randomUUID } from 'node:crypto'
import { and, asc, eq, exists, inArray, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch, changesOf, insertWhere } from '@shared/lib/db/batch'
import { agentVolumes, volumeDefinitions } from '@shared/lib/db/schema'
import type { ContainerVolume, MountedVolume, MountSummaryWithHealth, NotMountedVolume } from '@shared/lib/types/mount'
import { instantiateVolume } from '@shared/lib/volumes/volume-factory'
import { volumeProblem, volumeSummary } from '@shared/lib/volumes/volume-health'
import { prepareVolumeDefinition, selectableVolumes, storedDefinition, VolumeError, type VolumeViewer } from './volume-service'

export { volumeSummary } from '@shared/lib/volumes/volume-health'

/** Allocate inside the INSERT so concurrent attachments cannot claim the same
 * name. With N existing mounts, N+1 candidate suffixes always suffice. */
function availableMountName(slug: string, base: string) {
  return sql<string>`(with recursive candidates(n) as (
    select 1 union all select n + 1 from candidates
    where n <= (select count(*) from ${agentVolumes} where ${agentVolumes.agentSlug} = ${slug})
  ) select case when n = 1 then ${base} else ${base} || '-' || n end from candidates
    where not exists (select 1 from ${agentVolumes}
      where ${agentVolumes.agentSlug} = ${slug}
      and ${agentVolumes.name} = case when n = 1 then ${base} else ${base} || '-' || n end)
    order by n limit 1)`
}

export async function getMounts(slug: string, includePending = false): Promise<MountedVolume[]> {
  const rows = await db.select({ volume: volumeDefinitions, mount: agentVolumes })
    .from(agentVolumes).innerJoin(volumeDefinitions, eq(agentVolumes.volumeId, volumeDefinitions.id))
    .where(and(eq(agentVolumes.agentSlug, slug), includePending ? undefined : eq(agentVolumes.pendingRemoval, false))).orderBy(asc(agentVolumes.createdAt), asc(agentVolumes.id)).all()
  return rows.flatMap(({ volume, mount }) => {
    const stored = storedDefinition(volume)
    return stored ? [{ ...stored, id: mount.id, name: mount.name, volumeId: volume.id, ...(mount.pendingRemoval ? { pendingRemoval: true } : {}) }] : []
  })
}

/** The folder picker creates a source and attaches it atomically. */
export async function addMount(
  slug: string, type: string, config: unknown, viewer: VolumeViewer,
  options: { name?: string; visibility?: 'public' | 'private' } = {},
): Promise<MountedVolume> {
  const row = await prepareVolumeDefinition({ type, config, ...options }, viewer)
  const id = randomUUID()
  await batch([
    db.insert(volumeDefinitions).values(row),
    db.insert(agentVolumes).values({ id, agentSlug: slug, volumeId: row.id, name: availableMountName(slug, row.name), createdAt: new Date() }),
  ])
  const mount = (await getMounts(slug)).find(m => m.id === id)
  if (!mount) throw new VolumeError('Mount could not be loaded', 404)
  return mount
}

/** An existing source is referenced, never copied. Visibility is checked in the
 * INSERT itself, so a concurrent access change cannot be bypassed. */
export async function attachMount(slug: string, volumeId: string, viewer: VolumeViewer): Promise<MountedVolume> {
  const selection = and(eq(volumeDefinitions.id, volumeId), selectableVolumes(viewer))
  const source = await db.select().from(volumeDefinitions).where(selection).get()
  if (!source) throw new VolumeError('Volume not found', 404)
  const stored = storedDefinition(source)
  if (!stored || !instantiateVolume(stored)) throw new VolumeError('Volume configuration is unavailable', 400)
  const result = await insertWhere(agentVolumes, {
    id: randomUUID(), agentSlug: slug, volumeId, name: availableMountName(slug, source.name), createdAt: new Date(),
  }, exists(db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(selection)))
    .onConflictDoUpdate({ target: [agentVolumes.agentSlug, agentVolumes.volumeId], set: { pendingRemoval: false } }).run()
  // Idempotent attachment still requires current visibility.
  if (changesOf(result) === 0 && !await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(selection).get()) {
    throw new VolumeError('Volume not found', 404)
  }
  const mount = (await getMounts(slug)).find(m => m.volumeId === volumeId)
  if (!mount) throw new VolumeError('Mount could not be loaded', 404)
  return mount
}

export async function removeMount(slug: string, mountId: string): Promise<void> {
  // Keep the current generation's upload grant until a confirmed stop or a
  // fresh launch. The next generation's desired configuration excludes it.
  await db.update(agentVolumes).set({ pendingRemoval: true })
    .where(and(eq(agentVolumes.agentSlug, slug), eq(agentVolumes.id, mountId))).run()
}

export async function completeMountRemovals(slug: string, ids?: string[]): Promise<void> {
  if (ids?.length === 0) return
  await db.delete(agentVolumes).where(and(eq(agentVolumes.agentSlug, slug), eq(agentVolumes.pendingRemoval, true),
    ids ? inArray(agentVolumes.id, ids) : undefined)).run()
}

/** The attachment is the grant; knowing a shared definition's id grants no access. */
export async function resolveVolume(slug: string, mountId: string) {
  const row = (await getMounts(slug, true)).find(m => m.id === mountId)
  return row ? instantiateVolume(row) : null
}

async function judgeVolumes(slug: string, includePending = false) {
  return Promise.all((await getMounts(slug, includePending)).filter(row => includePending || !row.pendingRemoval)
    .map(async row => ({ row, reason: row.pendingRemoval ? null : await volumeProblem(row) })))
}

export async function listVolumes(slug: string): Promise<{ volumes: ContainerVolume[]; notMounted: NotMountedVolume[]; pendingRemovalIds?: string[] }> {
  const all = await judgeVolumes(slug, true)
  const pendingRemovalIds = all.filter(({ row }) => row.pendingRemoval).map(({ row }) => row.id)
  const judged = all.filter(({ row }) => !row.pendingRemoval)
  return {
    ...(pendingRemovalIds.length ? { pendingRemovalIds } : {}),
    volumes: judged.flatMap(({ row, reason }) => reason === null ? [{
      volumeId: row.id, name: row.name, cacheMode: instantiateVolume(row)?.cacheMode ?? 'local',
    }] : []),
    notMounted: judged.flatMap(({ row, reason }) => reason === null ? [] : [{ name: row.name, reason }]),
  }
}

export async function getMountsWithHealth(slug: string): Promise<MountSummaryWithHealth[]> {
  return (await judgeVolumes(slug, true)).map(({ row, reason }) => ({
    ...volumeSummary(row), volumeId: row.volumeId, health: reason === null ? 'ok' : 'missing',
    ...(row.pendingRemoval ? { pendingRemoval: true } : {}),
  }))
}

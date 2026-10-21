import { randomUUID } from 'node:crypto'
import { and, asc, eq, exists, isNotNull, isNull, sql } from 'drizzle-orm'
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

/** The agent's own drives, then every global drive it does not already have. Its own access wins. */
export async function getMounts(slug: string): Promise<MountedVolume[]> {
  const rows = await db.select({ volume: volumeDefinitions, mount: agentVolumes })
    .from(agentVolumes).innerJoin(volumeDefinitions, eq(agentVolumes.volumeId, volumeDefinitions.id))
    .where(eq(agentVolumes.agentSlug, slug)).orderBy(asc(agentVolumes.createdAt), asc(agentVolumes.id)).all()
  const own: MountedVolume[] = rows.flatMap(({ volume, mount }) => {
    const stored = storedDefinition(volume)
    return stored ? [{ ...stored, id: mount.id, name: mount.name, volumeId: volume.id, volumeName: volume.name, readOnly: mount.readOnly }] : []
  })
  const globals = await db.select().from(volumeDefinitions)
    .where(and(isNotNull(volumeDefinitions.globalAccess), isNull(volumeDefinitions.userId)))
    .orderBy(asc(volumeDefinitions.createdAt), asc(volumeDefinitions.id)).all()
  const names = new Set(own.map(mount => mount.name))
  const global: MountedVolume[] = globals.flatMap(volume => {
    const stored = own.some(mount => mount.volumeId === volume.id) ? null : storedDefinition(volume)
    if (!stored) return []
    const name = uniqueName(volume.name, names)
    names.add(name)
    // One id per agent, as with attachment rows: providers keep upload state per mount id.
    return [{ ...stored, id: `global-${slug}-${volume.id}`, name, volumeId: volume.id, volumeName: volume.name, readOnly: volume.globalAccess !== 'write', global: true }]
  })
  return [...own, ...global]
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
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
  if (!mount) throw new VolumeError('Drive could not be loaded', 404)
  return mount
}

/** An existing source is referenced, never copied. Visibility is checked in the
 * INSERT itself, so a concurrent access change cannot be bypassed. */
export async function attachMount(slug: string, volumeId: string, viewer: VolumeViewer): Promise<MountedVolume> {
  const selection = and(eq(volumeDefinitions.id, volumeId), selectableVolumes(viewer))
  const source = await db.select().from(volumeDefinitions).where(selection).get()
  if (!source) throw new VolumeError('Drive not found', 404)
  const stored = storedDefinition(source)
  if (!stored || !instantiateVolume(stored)) throw new VolumeError('Drive configuration is unavailable', 400)
  const result = await insertWhere(agentVolumes, {
    id: randomUUID(), agentSlug: slug, volumeId, name: availableMountName(slug, source.name), createdAt: new Date(),
  }, exists(db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(selection)))
    .onConflictDoNothing({ target: [agentVolumes.agentSlug, agentVolumes.volumeId] }).run()
  // Idempotent attachment still requires current visibility.
  if (changesOf(result) === 0 && !await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(selection).get()) {
    throw new VolumeError('Drive not found', 404)
  }
  const mount = (await getMounts(slug)).find(m => m.volumeId === volumeId)
  if (!mount) throw new VolumeError('Drive could not be loaded', 404)
  return mount
}

/** False when the agent has no such mount. Like attach and remove, the mount takes the change on the next start. */
export async function setMountReadOnly(slug: string, mountId: string, readOnly: boolean): Promise<boolean> {
  const result = await db.update(agentVolumes).set({ readOnly })
    .where(and(eq(agentVolumes.agentSlug, slug), eq(agentVolumes.id, mountId))).run()
  return changesOf(result) > 0
}

/** False when the agent has no such attachment, including a global drive. */
export async function removeMount(slug: string, mountId: string): Promise<boolean> {
  const result = await db.delete(agentVolumes).where(and(eq(agentVolumes.agentSlug, slug), eq(agentVolumes.id, mountId))).run()
  return changesOf(result) > 0
}

/** The agent's own attachment or a global drive is the grant; knowing a shared definition's id grants no access. */
export async function resolveVolume(slug: string, mountId: string) {
  const row = (await getMounts(slug)).find(m => m.id === mountId)
  if (!row) return null
  const ops = instantiateVolume(row, slug)
  return ops && { ops, readOnly: row.readOnly }
}

async function judgeVolumes(slug: string) {
  return Promise.all((await getMounts(slug)).map(async row => ({ row, reason: await volumeProblem(row, slug) })))
}

export async function listVolumes(slug: string): Promise<{ volumes: ContainerVolume[]; notMounted: NotMountedVolume[] }> {
  const judged = await judgeVolumes(slug)
  return {
    volumes: judged.flatMap(({ row, reason }) => {
      if (reason !== null) return []
      const driver = instantiateVolume(row)
      return [{ volumeId: row.id, name: row.name, volumeName: row.volumeName, cacheMode: driver?.cacheMode ?? 'local',
        ...(driver?.caseInsensitive ? { caseInsensitive: true } : {}),
        ...(driver?.ignoreSize ? { ignoreSize: true } : {}),
        ...(driver?.dirCacheSeconds ? { dirCacheSeconds: driver.dirCacheSeconds } : {}),
        ...(row.readOnly ? { readOnly: true } : {}) }]
    }),
    notMounted: judged.flatMap(({ row, reason }) => reason === null ? [] : [{ name: row.name, reason }]),
  }
}

export async function getMountsWithHealth(slug: string): Promise<MountSummaryWithHealth[]> {
  return (await judgeVolumes(slug)).map(({ row, reason }) => ({
    ...volumeSummary(row), volumeId: row.volumeId, volumeName: row.volumeName, readOnly: row.readOnly, health: reason === null ? 'ok' : 'missing',
    ...(row.global ? { global: true as const } : {}),
  }))
}

import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, exists, inArray, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch, changesOf, insertWhere } from '@shared/lib/db/batch'
import { agentAcl, agents, agentVolumes, volumeDefinitions } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import type { ContainerVolume, MountedVolume, MountSummaryWithHealth, NotMountedVolume } from '@shared/lib/types/mount'
import { instantiateVolume } from '@shared/lib/volumes/volume-factory'
import { volumeProblem, volumeSummary } from '@shared/lib/volumes/volume-health'
import { prepareVolumeDefinition, selectableVolumes, storedDefinition, VolumeError, type VolumeViewer } from './volume-service'
import { logAuditEvent } from './audit-log-service'
import { getUserSettings, type MyAgentDrive } from './user-settings-service'
import { captureException } from '@shared/lib/error-reporting'
import { serializeByKey } from '@shared/lib/utils/keyed-queue'

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

export async function getMounts(slug: string): Promise<MountedVolume[]> {
  const rows = await db.select({ volume: volumeDefinitions, mount: agentVolumes })
    .from(agentVolumes).innerJoin(volumeDefinitions, eq(agentVolumes.volumeId, volumeDefinitions.id))
    .where(eq(agentVolumes.agentSlug, slug)).orderBy(asc(agentVolumes.createdAt), asc(agentVolumes.id)).all()
  return rows.flatMap(({ volume, mount }) => {
    const stored = storedDefinition(volume)
    return stored ? [{ ...stored, id: mount.id, name: mount.name, volumeId: volume.id, volumeName: volume.name, readOnly: mount.readOnly }] : []
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
  if (!mount) throw new VolumeError('Drive could not be loaded', 404)
  return mount
}

/** An existing source is referenced, never copied. Visibility is checked in the
 * INSERT itself, so a concurrent access change cannot be bypassed. */
export async function attachMount(slug: string, volumeId: string, viewer: VolumeViewer, readOnly = false): Promise<MountedVolume> {
  const selection = and(eq(volumeDefinitions.id, volumeId), selectableVolumes(viewer))
  const source = await db.select().from(volumeDefinitions).where(selection).get()
  if (!source) throw new VolumeError('Drive not found', 404)
  const stored = storedDefinition(source)
  if (!stored || !instantiateVolume(stored)) throw new VolumeError('Drive configuration is unavailable', 400)
  const result = await insertWhere(agentVolumes, {
    id: randomUUID(), agentSlug: slug, volumeId, name: availableMountName(slug, source.name), readOnly, createdAt: new Date(),
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

/**
 * The user's agents: those they are the only member of, or with `shared`,
 * every agent they own. Without auth there is one user, so every agent.
 */
export async function listMyAgentSlugs(userId: string | null, shared: boolean): Promise<string[]> {
  if (!isAuthMode()) return (await db.select({ slug: agents.slug }).from(agents).all()).map(row => row.slug)
  if (userId === null) return []
  if (shared) {
    return (await db.select({ slug: agentAcl.agentSlug }).from(agentAcl)
      .where(and(eq(agentAcl.userId, userId), eq(agentAcl.role, 'owner'))).all()).map(row => row.slug)
  }
  // A viewer cannot add drives by hand (Add Drive needs the user role), so a sole viewer row does not count.
  const mine = db.select({ slug: agentAcl.agentSlug }).from(agentAcl)
    .where(and(eq(agentAcl.userId, userId), inArray(agentAcl.role, ['owner', 'user'])))
  const rows = await db.select({ slug: agentAcl.agentSlug }).from(agentAcl)
    .where(inArray(agentAcl.agentSlug, mine)).groupBy(agentAcl.agentSlug).having(eq(count(), 1)).all()
  return rows.map(row => row.slug)
}

/** What turning a drive on would reach: how many of the user's agents, and the shared ones by name. */
export async function previewMyAgents(userId: string | null, shared: boolean): Promise<{ agents: number; sharedAgents: string[] }> {
  const slugs = await listMyAgentSlugs(userId, shared)
  const privateSlugs = new Set(shared ? await listMyAgentSlugs(userId, false) : slugs)
  const sharedSlugs = slugs.filter(slug => !privateSlugs.has(slug))
  const sharedAgents = sharedSlugs.length
    ? (await db.select({ name: agents.name }).from(agents).where(inArray(agents.slug, sharedSlugs)).all()).map(row => row.name)
    : []
  return { agents: slugs.length, sharedAgents }
}

/**
 * Put a drive on an agent at `level`, replacing any access set on it by hand, and audit it like
 * Add Drive. Callers pick the agents. Returns what changed: null when the agent already had it at that level.
 */
export async function setMyAgentDrive(slug: string, volumeId: string, level: MyAgentDrive['level'], viewer: VolumeViewer): Promise<'created' | 'updated' | null> {
  const readOnly = level === 'read'
  const before = (await getMounts(slug)).find(m => m.volumeId === volumeId)
  if (before?.readOnly === readOnly) return null
  const mount = await attachMount(slug, volumeId, viewer, readOnly)
  if (mount.readOnly !== readOnly) await setMountReadOnly(slug, mount.id, readOnly)
  const change = before ? 'updated' : 'created'
  await logAuditEvent({ userId: viewer.userId ?? 'local', object: 'mount', objectId: `${slug}/${mount.id}`, action: change,
    details: before ? { readOnly } : { ...volumeSummary(mount), readOnly } })
  return change
}

/**
 * A new agent gets its owner's "all my agents" drives. Best effort: it never fails creating the agent.
 * Runs in the same per-user queue as the drive page's changes, so it never applies a level that was just changed.
 */
export function applyMyAgentDrives(slug: string, viewer: VolumeViewer): Promise<void> {
  const userKey = viewer.userId ?? 'local'
  return serializeByKey(`my-agents:${userKey}`, async () => {
    let drives: [string, MyAgentDrive][]
    try {
      drives = Object.entries((await getUserSettings(userKey)).myAgentDrives ?? {})
    } catch (error) {
      captureException(error, { tags: { component: 'volumes', operation: 'apply-my-agent-drives' }, extra: { agentSlug: slug }, level: 'warning' })
      return
    }
    const mine = new Map<boolean, string[]>()
    for (const [volumeId, setting] of drives) {
      try {
        const slugs = mine.get(setting.shared) ?? await listMyAgentSlugs(viewer.userId, setting.shared)
        mine.set(setting.shared, slugs)
        if (slugs.includes(slug)) await setMyAgentDrive(slug, volumeId, setting.level, viewer)
      } catch (error) {
        // A deleted or hidden drive is expected here: its id stays in the setting.
        if (error instanceof VolumeError) console.warn(`[volumes] Skipped drive ${volumeId} for new agent ${slug}: ${error.message}`)
        else captureException(error, { tags: { component: 'volumes', operation: 'apply-my-agent-drives' }, extra: { agentSlug: slug, volumeId }, level: 'warning' })
      }
    }
  })
}

export async function removeMount(slug: string, mountId: string): Promise<void> {
  await db.delete(agentVolumes).where(and(eq(agentVolumes.agentSlug, slug), eq(agentVolumes.id, mountId))).run()
}

/** The attachment is the grant; knowing a shared definition's id grants no access. */
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
  }))
}

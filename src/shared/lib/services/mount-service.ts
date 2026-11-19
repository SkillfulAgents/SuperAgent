import { randomUUID } from 'node:crypto'
import { and, asc, eq, exists, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch, changesOf, insertWhere } from '@shared/lib/db/batch'
import { agentAcl, agents, agentVolumes, volumeDefinitions } from '@shared/lib/db/schema'
import type { AgentRole } from '@shared/lib/types/agent'
import type { AgentMountSummary, ContainerVolume, MountedVolume, NotMountedVolume } from '@shared/lib/types/mount'
import { parseMountPath } from '@shared/lib/utils/workspace-path'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { instantiateVolume } from '@shared/lib/volumes/volume-factory'
import { volumeHealth, volumeProblem, volumeSummary } from '@shared/lib/volumes/volume-health'
import { prepareVolumeDefinition, reusableVolume, selectableVolumes, storedDefinition, VolumeError, type VolumeViewer } from './volume-service'

export { volumeSummary } from '@shared/lib/volumes/volume-health'

/** How long a container start waits for drives still making their first copy. Past it, the start goes on without them. */
const FIRST_COPY_WAIT_MS = 20_000

/** Reserve the current global names, which have no attachment rows. Allocate
 * inside the INSERT so concurrent attachments still see each other's names.
 * Attaching a drive the agent already has globally keeps its existing name. */
async function availableMountName(slug: string, base: string, volumeId?: string) {
  const globals = (await getMounts(slug)).filter(mount => mount.global)
  const inheritedName = globals.find(mount => mount.volumeId === volumeId)?.name ?? base
  const reserved = globals.filter(mount => mount.volumeId !== volumeId).map(mount => mount.name)
  const candidate = sql`case when n = 1 then ${inheritedName} else ${inheritedName} || '-' || n end`
  const unreserved = reserved.length > 0
    ? sql`${candidate} not in (${sql.join(reserved.map(name => sql`${name}`), sql`, `)})`
    : sql`1`
  // N occupied names need at most N+1 candidates, counting globals too.
  return sql<string>`(with recursive candidates(n) as (
    select 1 union all select n + 1 from candidates
    where n <= (select count(*) from ${agentVolumes} where ${agentVolumes.agentSlug} = ${slug}) + ${reserved.length}
  ) select ${candidate} from candidates
    where not exists (select 1 from ${agentVolumes}
      where ${agentVolumes.agentSlug} = ${slug}
      and ${agentVolumes.name} = ${candidate})
    and ${unreserved}
    order by n limit 1)`
}

/** Attachment rows with their definitions. Every caller's condition names the agent. */
const attachments = () => db.select({ volume: volumeDefinitions, mount: agentVolumes })
  .from(agentVolumes).innerJoin(volumeDefinitions, eq(agentVolumes.volumeId, volumeDefinitions.id))

function attachedMount({ volume, mount }: { volume: typeof volumeDefinitions.$inferSelect; mount: typeof agentVolumes.$inferSelect }): MountedVolume | null {
  const stored = storedDefinition(volume)
  return stored && { ...stored, id: mount.id, name: mount.name, volumeId: volume.id, volumeName: volume.name, readOnly: mount.readOnly }
}

/** What a global drive's mount id starts with for this agent: `global-<slug>-<volumeId>`. */
const globalMountPrefix = (slug: string) => `global-${slug}-`

/** The agent's own drives, then every global drive it does not already have. Its own access wins. */
export async function getMounts(slug: string): Promise<MountedVolume[]> {
  // Neither select reads the other's result, so they go out together.
  const [rows, globals] = await Promise.all([
    attachments().where(eq(agentVolumes.agentSlug, slug)).orderBy(asc(agentVolumes.createdAt), asc(agentVolumes.id)).all(),
    db.select().from(volumeDefinitions)
      .where(and(isNotNull(volumeDefinitions.globalAccess), eq(volumeDefinitions.visibility, 'public')))
      .orderBy(asc(volumeDefinitions.createdAt), asc(volumeDefinitions.id)).all(),
  ])
  const own: MountedVolume[] = rows.flatMap(row => attachedMount(row) ?? [])
  const names = new Set(own.map(mount => mount.name))
  const global: MountedVolume[] = globals.flatMap(volume => {
    const stored = own.some(mount => mount.volumeId === volume.id) ? null : storedDefinition(volume)
    if (!stored) return []
    const name = uniqueName(volume.name, names)
    names.add(name)
    // One id per agent, as with attachment rows: providers keep upload state per mount id.
    return [{ ...stored, id: `${globalMountPrefix(slug)}${volume.id}`, name, volumeId: volume.id, volumeName: volume.name, readOnly: volume.globalAccess !== 'write', global: true }]
  })
  return [...own, ...global]
}

/** The agents `getMounts` gives this drive: those it is attached to, or every agent while it is global. */
export async function agentsWithVolume(volumeId: string): Promise<string[]> {
  const global = await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions)
    .where(and(eq(volumeDefinitions.id, volumeId), isNotNull(volumeDefinitions.globalAccess), eq(volumeDefinitions.visibility, 'public'))).get()
  const rows = global
    ? await db.select({ agentSlug: agents.slug }).from(agents).all()
    : await db.select({ agentSlug: agentVolumes.agentSlug }).from(agentVolumes).where(eq(agentVolumes.volumeId, volumeId)).all()
  return [...new Set(rows.map(row => row.agentSlug))]
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/**
 * The folder picker creates a source and attaches it atomically. A source that already has a drive the viewer can see
 * attaches that drive, `unchanged` when the agent had it, or with `onlyNew` is refused.
 */
export async function addMount(
  slug: string, type: string, config: unknown, viewer: VolumeViewer,
  { onlyNew, ...options }: { name?: string; visibility?: 'public' | 'private'; onlyNew?: boolean } = {},
): Promise<MountedVolume & { unchanged?: true }> {
  const row = await prepareVolumeDefinition({ type, config, ...options }, viewer)
  const match = await reusableVolume(row, viewer)
  if (match && onlyNew) throw new VolumeError(`This folder is already the drive ${match.name}. Delete it in Settings → Drives, or pick another folder.`, 409)
  if (match) {
    const had = (await getMounts(slug)).some(mount => mount.volumeId === match.id && !mount.global)
    return { ...await attachMount(slug, match.id, viewer), ...(had ? { unchanged: true as const } : {}) }
  }
  const id = randomUUID()
  const name = await availableMountName(slug, row.name)
  await batch([
    db.insert(volumeDefinitions).values(row),
    db.insert(agentVolumes).values({ id, agentSlug: slug, volumeId: row.id, name, createdAt: new Date() }),
  ])
  const mount = (await getMounts(slug)).find(m => m.id === id)
  if (!mount) throw new VolumeError('Drive could not be loaded', 404)
  return mount
}

/** An existing source is referenced, never copied. Visibility is checked in the
 * INSERT itself, so a concurrent access change cannot be bypassed. */
export async function attachMount(slug: string, volumeId: string, viewer: VolumeViewer, { readOnly = false } = {}): Promise<MountedVolume> {
  const selection = and(eq(volumeDefinitions.id, volumeId), selectableVolumes(viewer))
  const source = await db.select().from(volumeDefinitions).where(selection).get()
  if (!source) throw new VolumeError('Drive not found', 404)
  const stored = storedDefinition(source)
  if (!stored || !instantiateVolume(stored)) throw new VolumeError('Drive configuration is unavailable', 400)
  const name = await availableMountName(slug, source.name, volumeId)
  const result = await insertWhere(agentVolumes, {
    id: randomUUID(), agentSlug: slug, volumeId, name, readOnly, createdAt: new Date(),
  }, exists(db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(selection)))
    // Asked for read-only, an attachment the agent already had becomes read-only too. It never becomes writable here.
    .onConflictDoUpdate({ target: [agentVolumes.agentSlug, agentVolumes.volumeId], set: { readOnly: sql`${agentVolumes.readOnly} OR excluded.read_only` } }).run()
  // Idempotent attachment still requires current visibility.
  if (changesOf(result) === 0 && !await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(selection).get()) {
    throw new VolumeError('Drive not found', 404)
  }
  const mount = (await getMounts(slug)).find(m => m.volumeId === volumeId)
  if (!mount) throw new VolumeError('Drive could not be loaded', 404)
  return mount
}

function attachmentOnAgent(slug: string, mountId: string) {
  return and(eq(agentVolumes.agentSlug, slug), eq(agentVolumes.id, mountId))
}

function selectableAttachment(viewer: VolumeViewer) {
  return inArray(agentVolumes.volumeId, db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(selectableVolumes(viewer)))
}

/** False when the agent has no such mount. Like attach and remove, the mount takes the change on the next start. */
export async function setMountReadOnly(slug: string, mountId: string, readOnly: boolean, viewer: VolumeViewer): Promise<boolean> {
  const result = await db.update(agentVolumes).set({ readOnly })
    .where(and(attachmentOnAgent(slug, mountId), selectableAttachment(viewer))).run()
  return changesOf(result) > 0
}

/** False when the agent has no such attachment, including a global drive. */
export async function removeMount(slug: string, mountId: string, viewer: VolumeViewer, agentRole?: AgentRole | null): Promise<boolean> {
  // Middleware can authorize a workspace admin as 'owner'. Only an actual owner
  // of this agent may detach a drive they cannot access. Check at the write.
  const ownsAgent = agentRole === 'owner' && viewer.userId
    ? exists(db.select({ id: agentAcl.id }).from(agentAcl).where(and(
      eq(agentAcl.agentSlug, slug), eq(agentAcl.userId, viewer.userId), eq(agentAcl.role, 'owner'),
    ))) : undefined
  const result = await db.delete(agentVolumes).where(and(attachmentOnAgent(slug, mountId), or(ownsAgent, selectableAttachment(viewer)))).run()
  return changesOf(result) > 0
}

/** The mount `getMounts(slug)` lists under this id, without listing the rest. An attachment is read by its
 * key, (agent, id), so another agent's attachment id finds nothing. A global drive's name depends on the
 * agent's other mounts, so an id shaped like this agent's global ones still goes through the full listing. */
async function mountById(slug: string, mountId: string): Promise<MountedVolume | null> {
  if (mountId.startsWith(globalMountPrefix(slug))) return (await getMounts(slug)).find(m => m.id === mountId) ?? null
  const row = await attachments().where(and(eq(agentVolumes.agentSlug, slug), eq(agentVolumes.id, mountId))).get()
  return row ? attachedMount(row) : null
}

/** The agent's own attachment or a global drive is the grant; knowing a shared definition's id grants no access. */
export async function resolveVolume(slug: string, mountId: string) {
  const row = await mountById(slug, mountId)
  if (!row) return null
  const ops = instantiateVolume(row, slug)
  return ops && { ops, readOnly: row.readOnly }
}

/** A person following a mount path needs direct access to the drive it resolves to. */
export async function resolveMountPath(slug: string, containerPath: string, viewer: VolumeViewer) {
  const parsed = parseMountPath(containerPath)
  if (!parsed) throw new WorkspaceFileError('invalid-path')
  const row = (await getMounts(slug)).find(m => m.name === parsed.name)
  if (!row || !await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions)
    .where(and(eq(volumeDefinitions.id, row.volumeId), selectableVolumes(viewer))).get()) return null
  const ops = instantiateVolume(row, slug)
  return ops ? { ops, path: parsed.path } : null
}

async function judgeVolumes(slug: string) {
  return Promise.all((await getMounts(slug)).map(async row => ({ row, reason: await volumeProblem(row, slug) })))
}

/** The agent's container just started, so each of its drives is mounted with an empty cache. */
export async function remounted(slug: string): Promise<void> {
  for (const row of await getMounts(slug)) instantiateVolume(row, slug)?.remounted()
}

/** Settles once each of the agent's drives that is copied first has a copy, or has stopped trying for now. */
export async function firstCopies(slug: string): Promise<void> {
  await Promise.all((await getMounts(slug)).map(row => instantiateVolume(row, slug)?.whenReady()))
}

/** `beforeRead` runs just before the drives are read: a change after it reaches a started agent only through a restart. */
export async function listVolumes(slug: string, beforeRead?: () => void): Promise<{ volumes: ContainerVolume[]; notMounted: NotMountedVolume[] }> {
  // A drive joins the container only when it starts, so a start right after adding one waits for its first copy.
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([firstCopies(slug), new Promise<void>(resolve => { timer = setTimeout(resolve, FIRST_COPY_WAIT_MS) })])
  clearTimeout(timer)
  beforeRead?.()
  const judged = await judgeVolumes(slug)
  return {
    volumes: judged.flatMap(({ row, reason }) => {
      if (reason !== null) return []
      const driver = instantiateVolume(row)
      return [{ volumeId: row.id, name: row.name, volumeName: row.volumeName, cacheMode: driver?.cacheMode ?? 'local',
        ...(driver?.caseInsensitive ? { caseInsensitive: true } : {}),
        ...(driver?.ignoreSize ? { ignoreSize: true } : {}),
        ...(driver?.dirCacheSeconds ? { dirCacheSeconds: driver.dirCacheSeconds } : {}),
        ...(row.readOnly || driver?.readOnly ? { readOnly: true } : driver?.agentNote && driver.sourceLabel ? { sourceLabel: driver.sourceLabel, agentNote: driver.agentNote } : {}) }]
    }),
    notMounted: judged.flatMap(({ row, reason }) => reason === null ? [] : [{ name: row.name, reason }]),
  }
}

export async function getMountsWithHealth(slug: string, viewer: VolumeViewer): Promise<AgentMountSummary[]> {
  const mounts = await getMounts(slug)
  if (!mounts.length) return []
  const visible = await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(and(selectableVolumes(viewer),
    or(isNotNull(volumeDefinitions.globalAccess), inArray(volumeDefinitions.id,
      db.select({ id: agentVolumes.volumeId }).from(agentVolumes).where(eq(agentVolumes.agentSlug, slug)))))).all()
  const ids = new Set(visible.map(volume => volume.id))
  return Promise.all(mounts.map(async row => {
    if (!ids.has(row.volumeId)) return { restricted: true as const, id: row.id, volumeName: row.volumeName }
    const reason = await volumeProblem(row, slug)
    return {
      ...volumeSummary(row), volumeId: row.volumeId, volumeName: row.volumeName, readOnly: row.readOnly, health: volumeHealth(reason),
      ...(row.global ? { global: true as const } : {}),
    }
  }))
}

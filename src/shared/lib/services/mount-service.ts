import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import {
  readJsonFileStrict,
  writeJsonFileAtomic,
  withFileLock,
  CorruptFileError,
} from '@shared/lib/utils/file-storage'
import { containerHost } from '@shared/lib/agent-actor'
import { captureException } from '@shared/lib/error-reporting'
import type { StoredVolume, VolumeSummary, VolumeSummaryWithHealth } from '@shared/lib/types/mount'
import { instantiateVolume, prepareVolume } from '@shared/lib/volumes/volume-types'
import type { BaseMountableVolume } from '@shared/lib/volumes/volumes'
import { storedVolumesSchema } from './mount-schema'

// The agent's volumes are host-only state, so the file sits at the agent's host
// path (from the container host, not the actor).
function getMountsFilePath(slug: string): string {
  return path.join(containerHost.agentHostPath(slug), 'mounts.json')
}

/**
 * Strict read for the read-modify-write paths (addMount/removeMount): an absent
 * file is `[]`, but a corrupt/torn `mounts.json` or IO error THROWS so the write
 * aborts instead of clobbering the file with just the new/remaining mount (the
 * previous catch-all swallowed bad reads, so the next write dropped every prior
 * mount). Do NOT use this on read-only display paths — use {@link getMounts}.
 */
function readMountsStrict(slug: string): Promise<StoredVolume[]> {
  return readJsonFileStrict(getMountsFilePath(slug), storedVolumesSchema, [])
}

/**
 * Read the agent's mounts for READ-ONLY consumers (the mounts UI, health checks,
 * and CONTAINER START). Tolerant: an absent file is `[]`, and a corrupt/unreadable
 * file degrades to `[]` (logged + captured) rather than throwing — a bad
 * mounts.json must not brick `getMountsWithHealth` (which runs on every container
 * start) or 500 the mounts route. This never writes, so degrading to `[]` is safe;
 * writes go through addMount/removeMount, which use the strict read and abort on
 * corruption instead of overwriting.
 */
export async function getMounts(slug: string): Promise<StoredVolume[]> {
  try {
    return await readMountsStrict(slug)
  } catch (error) {
    if (error instanceof CorruptFileError) {
      console.error(`Corrupt mounts.json for agent ${slug}; treating as no mounts (NOT overwriting)`, error)
      captureException(error, { tags: { area: 'mounts', op: 'read' }, extra: { agentSlug: slug } })
      return []
    }
    throw error
  }
}

async function writeMounts(slug: string, mounts: StoredVolume[]): Promise<void> {
  const filePath = getMountsFilePath(slug)
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  // Atomic temp-file + rename: an interrupted write can never truncate
  // mounts.json into the half-state the old reader would have swallowed.
  await writeJsonFileAtomic(filePath, storedVolumesSchema.parse(mounts))
}

export async function addMount(slug: string, type: string, config: unknown): Promise<StoredVolume> {
  const prepared = await prepareVolume(type, config)

  // The read-modify-write must not interleave with a concurrent add/remove for
  // the same agent (the old sync code got this for free by never yielding).
  return withFileLock(getMountsFilePath(slug), async () => {
    const mounts = await readMountsStrict(slug)

    // Pick the volume name, append -2, -3, etc. on collision
    let name = prepared.name
    let suffix = 2
    while (mounts.some((m) => m.name === name)) {
      name = `${prepared.name}-${suffix}`
      suffix++
    }

    const mount: StoredVolume = { id: crypto.randomUUID(), name, type, config: prepared.config }

    mounts.push(mount)
    await writeMounts(slug, mounts)
    return mount
  })
}

export function removeMount(slug: string, mountId: string): Promise<void> {
  return withFileLock(getMountsFilePath(slug), async () => {
    const mounts = await readMountsStrict(slug)
    const filtered = mounts.filter((m) => m.id !== mountId)
    await writeMounts(slug, filtered)
  })
}

/**
 * Each mounts.json row is one agent's volume and its id is the volume id, so a
 * volume not attached to this agent resolves to nothing.
 */
export async function resolveVolume(slug: string, volumeId: string): Promise<BaseMountableVolume<unknown> | null> {
  const row = (await getMounts(slug)).find((m) => m.id === volumeId)
  return row ? instantiateVolume(row) : null
}

// A volume is ok when it can be built and its root is a folder now.
async function isMountable(volume: BaseMountableVolume<unknown> | null): Promise<boolean> {
  if (!volume) return false
  try {
    return (await volume.stat('')).kind === 'directory'
  } catch {
    return false
  }
}

export function volumeSummary(row: StoredVolume, volume = instantiateVolume(row)): VolumeSummary {
  return { id: row.id, name: row.name, type: row.type, hostPath: volume?.hostPath ?? null }
}

export async function getMountsWithHealth(slug: string): Promise<VolumeSummaryWithHealth[]> {
  const mounts = await getMounts(slug)
  return Promise.all(
    mounts.map(async (m) => {
      const volume = instantiateVolume(m)
      return {
        ...volumeSummary(m, volume),
        health: (await isMountable(volume)) ? ('ok' as const) : ('missing' as const),
      }
    })
  )
}

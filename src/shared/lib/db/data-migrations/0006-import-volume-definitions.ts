import { createHash } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { agents, agentAcl, agentVolumes, volumeDefinitions } from '../schema'
import { readLegacyAgentMounts } from '@shared/lib/agent-actor/agent-directories'
import { legacyVolumeRowSchema } from '@shared/lib/services/mount-schema'
import type { DataMigration } from './index'

/** Stable per-agent identity avoids merging copied legacy rows across owners. */
export function legacyVolumeId(agentSlug: string, mountId: string): string {
  return `legacy-${createHash('sha256').update(`${agentSlug}\0${mountId}`).digest('hex')}`
}

export const importVolumeDefinitions: DataMigration = {
  id: 6,
  name: 'import-volume-definitions',
  async run(db) {
    const records = await db.select({ slug: agents.slug }).from(agents).all()
    for (const { slug } of records) {
      let rows: unknown[]
      try {
        rows = await readLegacyAgentMounts(slug)
      } catch (error) {
        // The old reader also left unreadable files unmounted. Keep the original
        // file for recovery rather than turning one bad mount into a boot failure.
        console.warn(`[volumes] Could not import mounts for ${slug}; original file retained:`, error)
        continue
      }
      // Legacy files did not record a creator. The agent's first owner is the
      // best available attribution; single-user installs have no ACL owner.
      const owner = await db.select({ userId: agentAcl.userId }).from(agentAcl)
        .where(and(eq(agentAcl.agentSlug, slug), eq(agentAcl.role, 'owner')))
        .orderBy(asc(agentAcl.createdAt), asc(agentAcl.id)).get()
      for (const raw of rows) {
        const parsed = legacyVolumeRowSchema.safeParse(raw)
        if (!parsed.success) {
          console.warn(`[volumes] Unrecognized mount for ${slug}; original file retained`)
          continue
        }
        const row = parsed.data
        const volumeId = legacyVolumeId(slug, row.id)
        const now = new Date()
        // Each insert is independently idempotent: a crash between them is
        // repaired on retry, without replacing a user's renamed definition.
        await db.insert(volumeDefinitions).values({
          id: volumeId, userId: owner?.userId ?? null, name: row.name, type: row.type,
          config: JSON.stringify(z.json().parse(row.config)), createdAt: now, updatedAt: now,
        }).onConflictDoNothing().run()
        await db.insert(agentVolumes).values({
          id: row.id, agentSlug: slug, volumeId, name: row.name, createdAt: now,
        }).onConflictDoNothing().run()
      }
    }
  },
}

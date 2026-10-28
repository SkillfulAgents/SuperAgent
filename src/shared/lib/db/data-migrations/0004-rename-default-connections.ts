import { and, eq } from 'drizzle-orm'
import { llmConnections } from '../schema'
import type { DataMigration } from './index'

/** Provider default names that changed, as [provider, old default, new default]. */
const RENAMED_DEFAULTS = [
  ['anthropic', 'Anthropic', 'Anthropic API'],
  ['platform', 'Platform', 'Gamut Platform'],
] as const

/** Connections are named after their provider when created; carry the new
 * defaults to rows that still use an old one. A name a user chose never
 * matches, and re-running is harmless: renamed rows no longer match either.
 */
export const renameDefaultConnections: DataMigration = {
  id: 4,
  name: 'rename-default-connections',
  async run(db) {
    for (const [provider, from, to] of RENAMED_DEFAULTS) {
      await db.update(llmConnections).set({ name: to })
        .where(and(eq(llmConnections.provider, provider), eq(llmConnections.name, from))).run()
    }
  },
}

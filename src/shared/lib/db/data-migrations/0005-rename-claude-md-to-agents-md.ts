/**
 * Rename every local agent's `CLAUDE.md` to `AGENTS.md`, the instructions file
 * new agents get. Re-running finds nothing left to move.
 */
import { eq } from 'drizzle-orm'
import { agents } from '../schema'
import { LOCAL_RUNTIME, renameClaudeMdToAgentsMdSync } from '@shared/lib/agent-actor/agent-directories'
import type { DataMigration, DataMigrationDb } from './index'

export async function renameAgentInstructions(db: DataMigrationDb): Promise<string[]> {
  const rows = await db.select({ slug: agents.slug }).from(agents).where(eq(agents.runtime, LOCAL_RUNTIME)).all()
  const renamed: string[] = []
  for (const { slug } of rows) {
    try {
      if (renameClaudeMdToAgentsMdSync(slug)) renamed.push(slug)
    } catch (error) {
      // The agent still works from its CLAUDE.md; a failed rename must not stop the app from opening.
      console.warn(`Could not rename CLAUDE.md to AGENTS.md for agent ${slug}:`, error)
    }
  }
  return renamed
}

export const renameClaudeMdToAgentsMd: DataMigration = {
  id: 5,
  name: 'rename-claude-md-to-agents-md',
  async run(db) {
    await renameAgentInstructions(db)
  },
}

/**
 * Import the agents that exist as directories into the `agents` table.
 *
 * Before the table, an agent existed because a directory existed under the
 * agents data directory, and its name and description lived in the
 * frontmatter of its instructions document (`AGENTS.md`, or legacy `CLAUDE.md`).
 * This one-time move gives every such directory a row: name from the frontmatter falling back to the slug, the
 * description, and the creation date from the frontmatter falling back to
 * the directory's birth time. A directory without readable instructions is
 * not an agent and is left alone. Directories the table already knows are
 * left alone too, so re-running is safe.
 */
import { agents } from '../schema'
import { LOCAL_RUNTIME, readAgentDirectoriesSync } from '@shared/lib/agent-actor/agent-directories'
import type { DataMigration, DataMigrationDb } from './index'

export async function importAgentDirectories(db: DataMigrationDb): Promise<string[]> {
  const rows = await db.select({ slug: agents.slug }).from(agents).all()
  const known = new Set(rows.map((row) => row.slug))
  const imported: string[] = []
  for (const found of readAgentDirectoriesSync()) {
    if (known.has(found.slug)) continue
    await db.insert(agents).values({
      slug: found.slug,
      name: found.name,
      description: found.description ?? null,
      createdAt: found.createdAt,
      runtime: LOCAL_RUNTIME,
      workspaceHandle: null,
    }).run()
    imported.push(found.slug)
  }
  return imported
}

export const importAgentsFromDirectories: DataMigration = {
  id: 1,
  name: 'import-agents-from-directories',
  async run(db) {
    await importAgentDirectories(db)
  },
}

/**
 * Import the agents that exist as directories into the `agents` table.
 *
 * Before the table, an agent existed because a directory existed under the
 * agents data directory, and its name and description lived in the
 * frontmatter of its `CLAUDE.md`. This one-time move gives every such
 * directory a row: name from the frontmatter falling back to the slug, the
 * description, and the creation date from the frontmatter falling back to
 * the directory's birth time. A directory without a readable `CLAUDE.md` is
 * not an agent and is left alone. Directories the table already knows are
 * left alone too, so re-running is safe.
 */
import { agents } from '../schema'
import { LOCAL_RUNTIME, readAgentDirectoriesSync } from '@shared/lib/agent-actor/agent-directories'
import type { DataMigration, DataMigrationDb } from './index'

export function importAgentDirectories(db: DataMigrationDb): string[] {
  const known = new Set(db.select({ slug: agents.slug }).from(agents).all().map((row) => row.slug))
  const imported: string[] = []
  for (const found of readAgentDirectoriesSync()) {
    if (known.has(found.slug)) continue
    db.insert(agents).values({
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
  run(db) {
    importAgentDirectories(db)
  },
}

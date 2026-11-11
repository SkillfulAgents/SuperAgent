/**
 * Earlier builds kept what the app knows about an agent's sessions (names,
 * stars, how each was started) in `session-metadata.json` in its workspace,
 * rewritten whole on every change. It is the agent's session index now, in
 * `agent_sessions`. Take every local agent's file into its index and remove
 * the file.
 *
 * Only the file is read here. The transcripts are statted when the agent's
 * sessions are first listed, once, by the index's own reconciliation.
 *
 * Re-running is safe: metadata already in the index wins, and an agent whose
 * file is gone has nothing left to take. It runs again on the next boot for
 * as long as some agent's file could not be taken in, or its workspace was
 * not there to look in: nothing else would ever read that file.
 */
import { eq } from 'drizzle-orm'
import { agents } from '../schema'
import type { DataMigration, DataMigrationDb } from './index'

/** The slugs of the agents whose file could not be taken in, or whose workspace was not there. */
export async function importSessionMetadata(db: DataMigrationDb): Promise<string[]> {
  // Loaded here, not at the top: the database bootstrap module graph stays small.
  const { LOCAL_RUNTIME } = await import('@shared/lib/agent-actor/agent-directories')
  const { createDbSessionIndexStorage } = await import('@shared/lib/agent-actor/db-session-index-storage')
  const { createLocalSessionStore } = await import('@shared/lib/agent-actor/local-session-store')
  const { ingestSessionMetadataFile } = await import('@shared/lib/services/session-metadata-file')

  const rows = await db.select({ slug: agents.slug }).from(agents).where(eq(agents.runtime, LOCAL_RUNTIME)).all()
  const failed: string[] = []
  for (const { slug } of rows) {
    try {
      // On the migration's handle: the app's own is not published yet.
      const store = createLocalSessionStore(slug, {
        sessionIndexStorage: (agent) => createDbSessionIndexStorage(agent, { db }),
      })
      // A workspace with nothing in it is not "no file": its volume may not
      // be mounted yet. An agent's own always holds its instructions at least.
      if ((await store.files.list('')).length === 0) throw new Error('The workspace is not there')
      await ingestSessionMetadataFile(store)
    } catch (error) {
      // The file stays where it is, and the agent's sessions list from their
      // transcripts without their names. It must not stop the app from opening.
      console.warn(`Could not import the session metadata of agent ${slug}:`, error)
      failed.push(slug)
    }
  }
  return failed
}

export const importSessionMetadataMigration: DataMigration = {
  id: 10,
  name: 'import-session-metadata',
  async run(db) {
    return (await importSessionMetadata(db)).length > 0 ? 'incomplete' : undefined
  },
}

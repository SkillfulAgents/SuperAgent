/**
 * Earlier builds copied the agent's slash-command list into every session's
 * entry of `session-metadata.json`, which grew the file by MBs a day on busy
 * agents. Keep the newest copy as the agent's `.slash-commands.json` (unless it
 * has one) and drop every session copy. Re-running finds nothing left to drop.
 */
import { eq } from 'drizzle-orm'
import { agents } from '../schema'
import { LOCAL_RUNTIME } from '@shared/lib/agent-actor/agent-directories'
import type { ConfigDoc } from '@shared/lib/agent-actor/config-schema'
import { createLocalSessionStore } from '@shared/lib/agent-actor/local-session-store'
import type { SessionStore } from '@shared/lib/agent-actor/session-store'
import type { SlashCommandInfo } from '@shared/lib/container/types'
import type { SessionMetadataMap } from '@shared/lib/types/agent'
import type { DataMigration, DataMigrationDb } from './index'

/** Whether the agent's session metadata held copies to drop. */
export async function moveAgentSlashCommands(store: SessionStore): Promise<boolean> {
  let moved = false
  await store.config.update('sessionMetadata', async (current) => {
    const metadata = { ...(current ?? {}) } as SessionMetadataMap
    let newest: { createdAt: string; commands: SlashCommandInfo[] } | null = null
    for (const [sessionId, entry] of Object.entries(metadata)) {
      if (!entry.slashCommands) continue
      const createdAt = entry.createdAt ?? ''
      if (!newest || createdAt > newest.createdAt) newest = { createdAt, commands: entry.slashCommands }
      const rest = { ...entry }
      delete rest.slashCommands
      metadata[sessionId] = rest
    }
    if (!newest) return null
    const commands = newest.commands
    // Kept before the session copies go: a failure leaves them for the next run.
    await store.config.update('slashCommands', (agentCopy) => (agentCopy === null ? (commands as ConfigDoc<'slashCommands'>) : null))
    moved = true
    return metadata as ConfigDoc<'sessionMetadata'>
  })
  return moved
}

export async function moveSessionSlashCommands(db: DataMigrationDb): Promise<string[]> {
  const rows = await db.select({ slug: agents.slug }).from(agents).where(eq(agents.runtime, LOCAL_RUNTIME)).all()
  const moved: string[] = []
  for (const { slug } of rows) {
    try {
      if (await moveAgentSlashCommands(createLocalSessionStore(slug))) moved.push(slug)
    } catch (error) {
      // A corrupt document is never rewritten; the agent works as before, and must not stop the app from opening.
      console.warn(`Could not move the slash commands out of the session metadata of agent ${slug}:`, error)
    }
  }
  return moved
}

export const moveSessionSlashCommandsMigration: DataMigration = {
  id: 8,
  name: 'move-session-slash-commands',
  async run(db) {
    await moveSessionSlashCommands(db)
  },
}

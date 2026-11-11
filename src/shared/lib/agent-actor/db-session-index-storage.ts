/**
 * `SessionIndexStorage` for an agent whose actor runs in this process: its
 * entries are the agent's rows of `agent_sessions` in the app database. The
 * only module that touches that table.
 *
 * No statement here needs a transaction or a batch, so the storage also runs
 * on the handle a data migration is given, before the app's own is published.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import type { AppDatabase } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { agentSessions } from '@shared/lib/db/schema'
import { sessionMetadataSchema } from '@shared/lib/services/session-metadata-schema'
import type { SessionMetadata } from '@shared/lib/types/agent'
import { REMOVE_SESSION, type SessionIndexEntry, type SessionIndexStorage } from './session-index'
import type { AgentSlug } from './types'

type SessionIndexDb = Pick<AppDatabase, 'select' | 'insert' | 'update' | 'delete'>
type Row = typeof agentSessions.$inferSelect

/** Rows per statement: well inside SQLite's bound-parameter limit at six columns a row. */
const ROWS_PER_STATEMENT = 500

/** A lost compare-and-set means another writer got in between; this many in a row means something else is wrong. */
const MAX_UPDATE_ATTEMPTS = 20

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += ROWS_PER_STATEMENT) out.push(items.slice(i, i + ROWS_PER_STATEMENT))
  return out
}

function encodeMeta(meta: SessionMetadata): string {
  return JSON.stringify(sessionMetadataSchema.parse(meta))
}

/**
 * Metadata is written through the schema, so only a build with a stricter
 * one, or a damaged row, finds some it cannot read. That session then lists
 * as one the app knows nothing about; it must not fail the agent's listing.
 */
function decodeMeta(stored: string): SessionMetadata | null {
  try {
    const parsed = sessionMetadataSchema.safeParse(JSON.parse(stored))
    return parsed.success ? (parsed.data as SessionMetadata) : null
  } catch {
    return null
  }
}

function entryOf(row: Row): SessionIndexEntry {
  return {
    sessionId: row.sessionId,
    meta: row.metadata === null ? null : decodeMeta(row.metadata),
    transcript: row.transcriptMtimeMs === null
      ? null
      : { mtimeMs: row.transcriptMtimeMs, birthtimeMs: row.transcriptBirthtimeMs ?? 0, size: row.transcriptSize ?? 0 },
  }
}

export function createDbSessionIndexStorage(slug: AgentSlug, given?: SessionIndexDb): SessionIndexStorage {
  // The app's handle is looked up per call: an actor outlives one open of the database.
  const database = (): SessionIndexDb => given ?? db
  // Built per call too: constructing a storage touches nothing.
  const ofAgent = () => eq(agentSessions.agentSlug, slug)
  const at = (sessionId: string) => and(ofAgent(), eq(agentSessions.sessionId, sessionId))
  // The row is still what a mutator was shown: the same metadata, and a
  // transcript seen or not. A transcript's activity moving does not count,
  // or every update of a streaming session would retry.
  const unchanged = (row: Row) => and(
    row.metadata === null ? isNull(agentSessions.metadata) : eq(agentSessions.metadata, row.metadata),
    row.transcriptMtimeMs === null ? isNull(agentSessions.transcriptMtimeMs) : isNotNull(agentSessions.transcriptMtimeMs),
  )

  return {
    get: async (sessionId) => {
      const row = await database().select().from(agentSessions).where(at(sessionId)).get()
      return row ? entryOf(row) : null
    },

    list: async () => (await database().select().from(agentSessions).where(ofAgent()).all()).map(entryOf),

    findByMeta: async (field, value) => {
      const rows = await database()
        .select()
        .from(agentSessions)
        .where(and(ofAgent(), sql`json_extract(${agentSessions.metadata}, ${`$.${field}`}) = ${value}`))
        .all()
      return rows.map(entryOf)
    },

    update: async (sessionId, mutate) => {
      for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
        const row = await database().select().from(agentSessions).where(at(sessionId)).get()
        const next = mutate(row ? entryOf(row) : null)
        if (next === null) return
        let result: unknown
        if (next === REMOVE_SESSION) {
          if (!row) return
          result = await database().delete(agentSessions).where(and(at(sessionId), unchanged(row))).run()
        } else if (row) {
          result = await database().update(agentSessions).set({ metadata: encodeMeta(next) }).where(and(at(sessionId), unchanged(row))).run()
        } else {
          result = await database().insert(agentSessions).values({ agentSlug: slug, sessionId, metadata: encodeMeta(next) }).onConflictDoNothing().run()
        }
        if (changesOf(result) > 0) return
      }
      throw new Error(`Session ${slug}/${sessionId} kept changing under an update`)
    },

    fill: async (entries) => {
      for (const chunk of chunks(entries)) {
        await database()
          .insert(agentSessions)
          .values(chunk.map(({ sessionId, meta, transcript }) => ({
            agentSlug: slug,
            sessionId,
            metadata: meta === null ? null : encodeMeta(meta),
            transcriptMtimeMs: transcript?.mtimeMs ?? null,
            transcriptBirthtimeMs: transcript?.birthtimeMs ?? null,
            transcriptSize: transcript?.size ?? null,
          })))
          .onConflictDoUpdate({
            target: [agentSessions.agentSlug, agentSessions.sessionId],
            set: {
              metadata: sql`coalesce(${agentSessions.metadata}, excluded.metadata)`,
              // The three transcript columns are written together, so one
              // null check decides for all of them.
              transcriptBirthtimeMs: sql`iif(${agentSessions.transcriptMtimeMs} is null, excluded.transcript_birthtime_ms, ${agentSessions.transcriptBirthtimeMs})`,
              transcriptSize: sql`iif(${agentSessions.transcriptMtimeMs} is null, excluded.transcript_size, ${agentSessions.transcriptSize})`,
              transcriptMtimeMs: sql`coalesce(${agentSessions.transcriptMtimeMs}, excluded.transcript_mtime_ms)`,
            },
          })
          .run()
      }
    },

    touch: async (activity) => {
      const leftAlone: string[] = []
      for (const [sessionId, activityAtMs] of activity) {
        const result = await database()
          .update(agentSessions)
          .set({
            transcriptMtimeMs: sql`max(${agentSessions.transcriptMtimeMs}, ${activityAtMs})`,
            // A write proves the transcript is not empty.
            transcriptSize: sql`max(${agentSessions.transcriptSize}, 1)`,
          })
          .where(and(at(sessionId), isNotNull(agentSessions.transcriptMtimeMs)))
          .run()
        if (changesOf(result) === 0) leftAlone.push(sessionId)
      }
      return leftAlone
    },

    delete: async (sessionIds) => {
      for (const chunk of chunks(sessionIds)) {
        await database().delete(agentSessions).where(and(ofAgent(), inArray(agentSessions.sessionId, chunk))).run()
      }
    },
  }
}

/** Drop every entry of an agent that is being removed. */
export async function dropDbSessionIndex(slug: AgentSlug): Promise<void> {
  await db.delete(agentSessions).where(eq(agentSessions.agentSlug, slug)).run()
}

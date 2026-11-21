/**
 * `SessionIndexStorage` in the agent's own object: its index entries are rows of that object's
 * SQLite, so the object can read its sessions without the app database. The object runs one call
 * at a time and SQLite here is synchronous, so a read-modify-write needs no compare-and-set.
 */
import type { SqlStorage, SqlStorageValue } from 'cloudflare:workers'
import { REMOVE_SESSION, type SessionIndexEntry, type SessionIndexStorage } from '@shared/lib/agent-actor/session-index'
import { sessionMetadataSchema } from '@shared/lib/services/session-metadata-schema'
import type { SessionMetadata } from '@shared/lib/types/agent'

const SESSION_INDEX_TABLE = 'agent_session'

const SESSION_INDEX_SCHEMA = `CREATE TABLE IF NOT EXISTS ${SESSION_INDEX_TABLE} (
  session_id TEXT PRIMARY KEY,
  metadata TEXT,
  transcript_mtime_ms REAL,
  transcript_birthtime_ms REAL,
  transcript_size INTEGER
)`

type Row = {
  session_id: string
  metadata: string | null
  transcript_mtime_ms: number | null
  transcript_birthtime_ms: number | null
  transcript_size: number | null
}

function encodeMeta(meta: SessionMetadata): string {
  return JSON.stringify(sessionMetadataSchema.parse(meta))
}

/** A row this build cannot read lists as a session the app knows nothing about, as in the app database. */
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
    sessionId: row.session_id,
    meta: row.metadata === null ? null : decodeMeta(row.metadata),
    transcript: row.transcript_mtime_ms === null
      ? null
      : { mtimeMs: row.transcript_mtime_ms, birthtimeMs: row.transcript_birthtime_ms ?? 0, size: row.transcript_size ?? 0 },
  }
}

/** Every entry of the agent, when the agent is deleted. */
export function dropObjectSessionIndex(sql: SqlStorage): void {
  sql.exec(`DROP TABLE IF EXISTS ${SESSION_INDEX_TABLE}`)
}

/**
 * `objectSql` is looked up per call: the storage is built wherever the actor is, and used only in
 * its object. The table is made on first use, so an object that never indexes a session has none.
 */
export function createObjectSessionIndexStorage(objectSql: () => SqlStorage): SessionIndexStorage {
  const sql = () => {
    const storage = objectSql()
    storage.exec(SESSION_INDEX_SCHEMA)
    return storage
  }
  const rows = (query: string, ...bindings: SqlStorageValue[]) => sql().exec<Row>(query, ...bindings).toArray()
  const get = (sessionId: string) => rows(`SELECT * FROM ${SESSION_INDEX_TABLE} WHERE session_id = ?`, sessionId)[0] ?? null

  return {
    get: async (sessionId) => {
      const row = get(sessionId)
      return row ? entryOf(row) : null
    },

    list: async () => rows(`SELECT * FROM ${SESSION_INDEX_TABLE}`).map(entryOf),

    findByMeta: async (field, value) =>
      rows(`SELECT * FROM ${SESSION_INDEX_TABLE} WHERE json_extract(metadata, ?) = ?`, `$.${field}`, value).map(entryOf),

    update: async (sessionId, mutate) => {
      const row = get(sessionId)
      const next = mutate(row ? entryOf(row) : null)
      if (next === null) return
      if (next === REMOVE_SESSION) {
        sql().exec(`DELETE FROM ${SESSION_INDEX_TABLE} WHERE session_id = ?`, sessionId)
      } else if (row) {
        sql().exec(`UPDATE ${SESSION_INDEX_TABLE} SET metadata = ? WHERE session_id = ?`, encodeMeta(next), sessionId)
      } else {
        sql().exec(`INSERT INTO ${SESSION_INDEX_TABLE} (session_id, metadata) VALUES (?, ?)`, sessionId, encodeMeta(next))
      }
    },

    fill: async (entries) => {
      for (const { sessionId, meta, transcript } of entries) {
        // SET reads the row as it was, so one null check on the old mtime decides all three transcript columns.
        sql().exec(
          `INSERT INTO ${SESSION_INDEX_TABLE} (session_id, metadata, transcript_mtime_ms, transcript_birthtime_ms, transcript_size)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (session_id) DO UPDATE SET
             metadata = coalesce(metadata, excluded.metadata),
             transcript_birthtime_ms = iif(transcript_mtime_ms IS NULL, excluded.transcript_birthtime_ms, transcript_birthtime_ms),
             transcript_size = iif(transcript_mtime_ms IS NULL, excluded.transcript_size, transcript_size),
             transcript_mtime_ms = coalesce(transcript_mtime_ms, excluded.transcript_mtime_ms)`,
          sessionId,
          meta === null ? null : encodeMeta(meta),
          transcript?.mtimeMs ?? null,
          transcript?.birthtimeMs ?? null,
          transcript?.size ?? null,
        )
      }
    },

    touch: async (activity) => {
      const leftAlone: string[] = []
      for (const [sessionId, activityAtMs] of activity) {
        // A write proves the transcript is not empty.
        const cursor = sql().exec(
          `UPDATE ${SESSION_INDEX_TABLE} SET transcript_mtime_ms = max(transcript_mtime_ms, ?), transcript_size = max(transcript_size, 1)
           WHERE session_id = ? AND transcript_mtime_ms IS NOT NULL`,
          activityAtMs,
          sessionId,
        )
        if (cursor.rowsWritten === 0) leftAlone.push(sessionId)
      }
      return leftAlone
    },

    delete: async (sessionIds) => {
      for (const sessionId of sessionIds) sql().exec(`DELETE FROM ${SESSION_INDEX_TABLE} WHERE session_id = ?`, sessionId)
    },
  }
}

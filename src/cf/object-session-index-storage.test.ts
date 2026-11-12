import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { SqlStorage } from 'cloudflare:workers'
import { REMOVE_SESSION } from '@shared/lib/agent-actor/session-index'
import type { SessionMetadata } from '@shared/lib/types/agent'
import { createObjectSessionIndexStorage, dropObjectSessionIndex } from './object-session-index-storage'

/** An object's SQLite in memory. */
function objectSql(): SqlStorage {
  const db = new Database(':memory:')
  return {
    exec: (query: string, ...bindings: unknown[]) => {
      const statement = db.prepare(query)
      if (statement.reader) {
        const rows = statement.all(...bindings)
        return { toArray: () => rows, one: () => rows[0], rowsWritten: 0 }
      }
      const { changes } = statement.run(...bindings)
      return { toArray: () => [], one: () => undefined, rowsWritten: changes }
    },
  } as unknown as SqlStorage
}

const meta = (name: string, extra: Partial<SessionMetadata> = {}) => ({ name, createdAt: '2026-11-12T09:00:00.000Z', ...extra }) as SessionMetadata
const transcript = (mtimeMs: number) => ({ mtimeMs, birthtimeMs: 1, size: 120 })

describe('createObjectSessionIndexStorage', () => {
  it('keeps what is stored when filled again, and adds what is missing', async () => {
    const sql = objectSql()
    const storage = createObjectSessionIndexStorage(() => sql)

    await storage.fill([{ sessionId: 'weekly-report', meta: meta('Weekly report'), transcript: null }])
    await storage.fill([
      { sessionId: 'weekly-report', meta: meta('Renamed by the scan'), transcript: transcript(2_000) },
      { sessionId: 'lead-research', meta: null, transcript: transcript(1_000) },
    ])

    expect(await storage.get('weekly-report')).toEqual({ sessionId: 'weekly-report', meta: meta('Weekly report'), transcript: transcript(2_000) })
    expect(await storage.get('lead-research')).toEqual({ sessionId: 'lead-research', meta: null, transcript: transcript(1_000) })
  })

  it('updates, finds by metadata and removes an entry', async () => {
    const sql = objectSql()
    const storage = createObjectSessionIndexStorage(() => sql)

    await storage.update('daily-digest', () => meta('Daily digest', { scheduledTaskId: 'task-7' }))
    expect((await storage.findByMeta('scheduledTaskId', 'task-7')).map((entry) => entry.sessionId)).toEqual(['daily-digest'])

    await storage.update('daily-digest', (current) => ({ ...current!.meta!, name: 'Morning digest' }))
    expect((await storage.get('daily-digest'))?.meta?.name).toBe('Morning digest')

    await storage.update('daily-digest', () => REMOVE_SESSION)
    expect(await storage.list()).toEqual([])
  })

  it('moves activity forward only on sessions whose transcript was seen', async () => {
    const sql = objectSql()
    const storage = createObjectSessionIndexStorage(() => sql)
    await storage.fill([
      { sessionId: 'seen', meta: null, transcript: transcript(5_000) },
      { sessionId: 'not-seen', meta: meta('Not seen yet'), transcript: null },
    ])

    const leftAlone = await storage.touch(new Map([['seen', 4_000], ['not-seen', 6_000], ['unknown', 7_000]]))

    expect(leftAlone).toEqual(['not-seen', 'unknown'])
    expect((await storage.get('seen'))?.transcript?.mtimeMs).toBe(5_000)
    await storage.touch(new Map([['seen', 9_000]]))
    expect((await storage.get('seen'))?.transcript?.mtimeMs).toBe(9_000)
  })

  it('deletes entries, and every entry when the agent is dropped', async () => {
    const sql = objectSql()
    const storage = createObjectSessionIndexStorage(() => sql)
    await storage.fill(['a', 'b', 'c'].map((sessionId) => ({ sessionId, meta: null, transcript: transcript(1) })))

    await storage.delete(['a', 'b'])
    expect((await storage.list()).map((entry) => entry.sessionId)).toEqual(['c'])

    dropObjectSessionIndex(sql)
    expect(await storage.list()).toEqual([])
  })
})

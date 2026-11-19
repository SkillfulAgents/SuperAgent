/**
 * `SessionIndexStorage` in memory: for tests that drive the session service
 * or an agent's live sessions without a database.
 */
import { beforeEach } from 'vitest'
import { sessionMetadataSchema } from '@shared/lib/services/session-metadata-schema'
import type { SessionMetadata } from '@shared/lib/types/agent'
import { REMOVE_SESSION, type SessionIndexEntry, type SessionIndexStorage } from '../session-index'

export function createInMemorySessionIndexStorage(): SessionIndexStorage {
  const entries = new Map<string, SessionIndexEntry>()
  // Stored and handed out as copies, validated as a database row would be.
  const stored = (meta: SessionMetadata): SessionMetadata =>
    sessionMetadataSchema.parse(JSON.parse(JSON.stringify(meta))) as SessionMetadata
  const copy = (entry: SessionIndexEntry): SessionIndexEntry => ({
    sessionId: entry.sessionId,
    meta: entry.meta && stored(entry.meta),
    transcript: entry.transcript && { ...entry.transcript },
  })

  return {
    get: async (sessionId) => {
      const entry = entries.get(sessionId)
      return entry ? copy(entry) : null
    },
    list: async () => [...entries.values()].map(copy),
    findByMeta: async (field, value) =>
      [...entries.values()].filter((entry) => entry.meta?.[field] === value).map(copy),
    update: async (sessionId, mutate) => {
      const current = entries.get(sessionId)
      const next = mutate(current ? copy(current) : null)
      if (next === null) return
      if (next === REMOVE_SESSION) entries.delete(sessionId)
      else entries.set(sessionId, { sessionId, meta: stored(next), transcript: current?.transcript ?? null })
    },
    fill: async (filled) => {
      for (const entry of filled) {
        const current = entries.get(entry.sessionId)
        entries.set(entry.sessionId, copy({
          sessionId: entry.sessionId,
          meta: current?.meta ?? entry.meta,
          transcript: current?.transcript ?? entry.transcript,
        }))
      }
    },
    touch: async (activity) => {
      const leftAlone: string[] = []
      for (const [sessionId, activityAtMs] of activity) {
        const transcript = entries.get(sessionId)?.transcript
        if (!transcript) {
          leftAlone.push(sessionId)
          continue
        }
        transcript.mtimeMs = Math.max(transcript.mtimeMs, activityAtMs)
        transcript.size = Math.max(transcript.size, 1)
      }
      return leftAlone
    },
    delete: async (sessionIds) => {
      for (const sessionId of sessionIds) entries.delete(sessionId)
    },
  }
}

/**
 * Stands in for the `db-session-index-storage` module in a test file that
 * builds local session stores, or real actors, but has no database:
 *
 *   vi.mock('@shared/lib/agent-actor/db-session-index-storage', async () =>
 *     (await import('@shared/lib/agent-actor/testing/in-memory-session-index-storage')).inMemorySessionIndexModule())
 *
 * Every store of one agent shares one storage, as they share the table, and
 * every test starts with none.
 */
export function inMemorySessionIndexModule(): typeof import('../db-session-index-storage') {
  const storages = new Map<string, SessionIndexStorage>()
  beforeEach(() => storages.clear())
  const storageOf = (slug: string): SessionIndexStorage => {
    let storage = storages.get(slug)
    if (!storage) storages.set(slug, (storage = createInMemorySessionIndexStorage()))
    return storage
  }
  return {
    // Looked up per call: a store built in one test must not write into the next one's.
    createDbSessionIndexStorage: (slug) => ({
      get: (...args) => storageOf(slug).get(...args),
      list: () => storageOf(slug).list(),
      findByMeta: (...args) => storageOf(slug).findByMeta(...args),
      update: (...args) => storageOf(slug).update(...args),
      fill: (...args) => storageOf(slug).fill(...args),
      touch: (...args) => storageOf(slug).touch(...args),
      delete: (...args) => storageOf(slug).delete(...args),
    }),
    dropDbSessionIndex: async (slug) => {
      storages.delete(slug)
    },
  }
}

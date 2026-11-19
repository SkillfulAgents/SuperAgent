import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { setMaxBoundParameters } from '@shared/lib/db/bound-parameters'
import { agentSessions } from '@shared/lib/db/schema'
import { createTestDatabase } from '@shared/lib/db/testing/create-test-database'
import { perTestDatabase } from '@shared/lib/db/testing/per-test-database'
import type { AppDatabase } from '@shared/lib/db'
import { createDbSessionIndexStorage, dropDbSessionIndex } from './db-session-index-storage'
import { describeSessionIndexStorageContract } from './testing/session-index-storage-contract'

/** The app's handle, recording how many parameters each write it runs binds. */
function countingBoundParameters(db: AppDatabase): { db: AppDatabase; counts: number[] } {
  const counts: number[] = []
  const track = <T extends object>(builder: T): T => new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      if (prop === 'run') {
        return (...args: unknown[]) => {
          counts.push((target as unknown as { toSQL(): { params: unknown[] } }).toSQL().params.length)
          return value.apply(target, args)
        }
      }
      return (...args: unknown[]) => {
        const next = value.apply(target, args)
        return next && typeof next === 'object' && 'toSQL' in next ? track(next) : next
      }
    },
  })
  const counting = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop !== 'insert' && prop !== 'delete') return value
      return (...args: unknown[]) => track(value.apply(target, args))
    },
  })
  return { db: counting, counts }
}

const database = perTestDatabase()
vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))

// How many statements each batch the storage sent held: a batch is one round trip.
const batchSizes = vi.hoisted(() => [] as number[])
vi.mock('@shared/lib/db/batch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/db/batch')>()
  return {
    ...actual,
    batch: (statements: Parameters<typeof actual.batch>[0]) => {
      batchSizes.push(statements.length)
      return actual.batch(statements)
    },
  }
})

describeSessionIndexStorageContract('DbSessionIndexStorage', () => ({
  storage: createDbSessionIndexStorage('agent-one'),
  other: createDbSessionIndexStorage('agent-two'),
}))

describe('DbSessionIndexStorage', () => {
  it('touches no database until an operation runs', () => {
    const select = vi.spyOn(database.db, 'select')
    createDbSessionIndexStorage('agent-one')
    expect(select).not.toHaveBeenCalled()
  })

  it('runs on the handle it is given', async () => {
    // A data migration's handle: not the one the app publishes.
    const migrating = await createTestDatabase()
    try {
      const storage = createDbSessionIndexStorage('agent-one', migrating.db)
      await storage.fill([{ sessionId: 's1', meta: { name: 'First' }, transcript: null }])
      await storage.update('s1', (current) => ({ ...current?.meta, starred: true }))
      await storage.touch(new Map([['s1', 5]]))

      expect((await storage.get('s1'))?.meta).toEqual({ name: 'First', starred: true })
      expect(await createDbSessionIndexStorage('agent-one').list()).toEqual([])
    } finally {
      await migrating.close()
    }
  })

  describe('touch', () => {
    const seen = (sessionId: string) => ({ sessionId, meta: null, transcript: { mtimeMs: 1000, birthtimeMs: 1, size: 0 } })

    it('stores the activity of several sessions in one batch, and says which it left alone', async () => {
      const storage = createDbSessionIndexStorage('agent-one')
      await storage.fill([seen('s1'), seen('s2'), seen('s3'), { sessionId: 'registered', meta: { name: 'No transcript yet' }, transcript: null }])
      batchSizes.length = 0
      const update = vi.spyOn(database.db, 'update')

      const leftAlone = await storage.touch(new Map([['s1', 5000], ['registered', 5000], ['s2', 500], ['unknown', 5000], ['s3', 7000]]))

      expect(batchSizes).toEqual([5])
      expect(update).toHaveBeenCalledTimes(5)
      expect(leftAlone).toEqual(['registered', 'unknown'])
      expect((await storage.list()).map((entry) => [entry.sessionId, entry.transcript?.mtimeMs ?? null, entry.transcript?.size ?? null]).sort()).toEqual([
        ['registered', null, null],
        ['s1', 5000, 1],
        // Never moved back.
        ['s2', 1000, 1],
        ['s3', 7000, 1],
      ])
    })

    it('stores one session\'s activity as one statement, with no batch around it', async () => {
      const storage = createDbSessionIndexStorage('agent-one')
      await storage.fill([seen('s1')])
      batchSizes.length = 0

      expect(await storage.touch(new Map([['s1', 5000]]))).toEqual([])

      expect(batchSizes).toEqual([])
      expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(5000)
    })

    it('sends no batch to the app\'s database for a handle it was given', async () => {
      const migrating = await createTestDatabase()
      try {
        const storage = createDbSessionIndexStorage('agent-one', migrating.db)
        await storage.fill([seen('s1'), seen('s2')])
        batchSizes.length = 0

        expect(await storage.touch(new Map([['s1', 5000], ['s2', 6000], ['unknown', 1]]))).toEqual(['unknown'])

        expect(batchSizes).toEqual([])
        expect((await storage.get('s1'))?.transcript?.mtimeMs).toBe(5000)
        expect((await storage.get('s2'))?.transcript?.mtimeMs).toBe(6000)
      } finally {
        await migrating.close()
      }
    })
  })

  it('hands out a row whose stored metadata it cannot read as one without metadata, and the rest as they are', async () => {
    await database.db.insert(agentSessions).values([
      { agentSlug: 'agent-one', sessionId: 'wrong-shape', metadata: '{"name":42}', transcriptMtimeMs: 5, transcriptBirthtimeMs: 1, transcriptSize: 9 },
      { agentSlug: 'agent-one', sessionId: 'not-json', metadata: '{"name":' },
      { agentSlug: 'agent-one', sessionId: 'fine', metadata: '{"name":"Fine"}' },
    ]).run()
    const storage = createDbSessionIndexStorage('agent-one')

    expect((await storage.list()).sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { sessionId: 'fine', meta: { name: 'Fine' }, transcript: null },
      { sessionId: 'not-json', meta: null, transcript: null },
      { sessionId: 'wrong-shape', meta: null, transcript: { mtimeMs: 5, birthtimeMs: 1, size: 9 } },
    ])
    // And it can be given metadata again.
    await storage.update('wrong-shape', () => ({ name: 'Renamed' }))
    expect((await storage.get('wrong-shape'))?.meta).toEqual({ name: 'Renamed' })
  })

  it('drops every entry of an agent, and only that agent\'s', async () => {
    const one = createDbSessionIndexStorage('agent-one')
    const two = createDbSessionIndexStorage('agent-two')
    await one.update('s1', () => ({ name: 'One' }))
    await one.fill([{ sessionId: 's2', meta: null, transcript: { mtimeMs: 1, birthtimeMs: 0, size: 1 } }])
    await two.update('s1', () => ({ name: 'Two' }))

    await dropDbSessionIndex('agent-one')

    expect(await one.list()).toEqual([])
    expect(await database.db.select().from(agentSessions).where(eq(agentSessions.agentSlug, 'agent-two')).all()).toHaveLength(1)
  })

  describe('on a driver that binds at most 100 parameters a statement', () => {
    afterEach(() => setMaxBoundParameters(undefined))

    it('keeps every fill and delete statement within that limit', async () => {
      setMaxBoundParameters(100)
      const { db, counts } = countingBoundParameters(database.db)
      const storage = createDbSessionIndexStorage('agent-one', db)
      const sessionIds = Array.from({ length: 120 }, (_, i) => `s${i}`)

      await storage.fill(sessionIds.map((sessionId) => ({ sessionId, meta: { name: sessionId }, transcript: { mtimeMs: 2, birthtimeMs: 1, size: 3 } })))
      expect(await storage.list()).toHaveLength(120)
      await storage.delete(sessionIds)
      expect(await storage.list()).toEqual([])

      // 16 rows a statement: 8 fills and 8 deletes.
      expect(counts).toHaveLength(16)
      expect(Math.max(...counts)).toBeLessThanOrEqual(100)
    })
  })

  it('fills in one statement on SQLite\'s own limit', async () => {
    const { db, counts } = countingBoundParameters(database.db)
    const storage = createDbSessionIndexStorage('agent-one', db)

    await storage.fill(Array.from({ length: 120 }, (_, i) => ({ sessionId: `s${i}`, meta: null, transcript: null })))

    expect(counts).toHaveLength(1)
  })
})

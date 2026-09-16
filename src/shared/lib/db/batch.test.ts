import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { count, eq, lt, sql } from 'drizzle-orm'
import * as schema from './schema'

let sqlite: InstanceType<typeof Database>
let testDb: ReturnType<typeof drizzle<typeof schema>>

vi.mock('./index', () => ({
  get db() {
    return testDb
  },
}))

import { batch, changesOf, insertWhere } from './batch'

const { agents, pushSubscriptions } = schema

function slugs() {
  return testDb.select({ slug: agents.slug }).from(agents).orderBy(agents.slug).all().map((row) => row.slug)
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  testDb = drizzle(sqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
})

afterEach(() => {
  sqlite.close()
})

describe('batch', () => {
  it('runs the statements in order and returns each run result', async () => {
    const now = new Date()
    const results = await batch([
      testDb.insert(agents).values({ slug: 'a', name: 'A', createdAt: now }),
      testDb.insert(agents).values({ slug: 'b', name: 'B', createdAt: now }),
      testDb.delete(agents).where(eq(agents.slug, 'a')),
    ])

    expect(results.map(changesOf)).toEqual([1, 1, 1])
    expect(slugs()).toEqual(['b'])
  })

  it('commits nothing when a later statement fails', async () => {
    const now = new Date()
    testDb.insert(agents).values({ slug: 'taken', name: 'Taken', createdAt: now }).run()

    await expect(
      batch([
        testDb.insert(agents).values({ slug: 'new', name: 'New', createdAt: now }),
        testDb.insert(agents).values({ slug: 'taken', name: 'Duplicate', createdAt: now }),
      ]),
    ).rejects.toThrow()

    expect(slugs()).toEqual(['taken'])
  })

  it('a later statement sees an earlier one', async () => {
    const now = new Date()
    testDb.insert(agents).values({ slug: 'old', name: 'Old', createdAt: now }).run()
    const results = await batch([
      testDb.delete(agents).where(eq(agents.slug, 'old')),
      testDb.update(agents).set({ name: 'Renamed' }).where(eq(agents.slug, 'old')),
    ])
    expect(results.map(changesOf)).toEqual([1, 0])
  })

  it('does nothing for an empty list', async () => {
    expect(await batch([])).toEqual([])
  })

  it('uses the driver batch when the handle offers one', async () => {
    const driverBatch = vi.fn(async (statements: readonly unknown[]) => statements.map(() => ({ rowsAffected: 1 })))
    const previous = testDb
    testDb = { batch: driverBatch } as unknown as typeof testDb
    try {
      const statement = previous.delete(agents)
      const results = await batch([statement])
      expect(driverBatch).toHaveBeenCalledWith([statement])
      expect(results.map(changesOf)).toEqual([1])
    } finally {
      testDb = previous
    }
  })
})

describe('changesOf', () => {
  it('reads every driver shape', () => {
    expect(changesOf({ changes: 2, lastInsertRowid: 9 })).toBe(2)
    expect(changesOf({ rowsAffected: 3 })).toBe(3)
    expect(changesOf({ meta: { changes: 4 } })).toBe(4)
  })

  it('refuses a shape it does not know rather than guessing zero', () => {
    expect(() => changesOf(undefined)).toThrow('unrecognised run result')
    expect(() => changesOf({})).toThrow('unrecognised run result')
  })
})

describe('insertWhere', () => {
  const now = new Date('2026-09-15T12:00:00.000Z')
  const row = (endpoint: string) => ({
    id: endpoint,
    endpoint,
    keysP256dh: 'p',
    keysAuth: 'a',
    origin: 'https://example.test',
    userId: null,
    deviceName: null,
    createdAt: now,
    updatedAt: now,
  })
  const underCap = (cap: number) => lt(testDb.select({ n: count() }).from(pushSubscriptions), cap)

  it('inserts when the condition holds and reports one change', async () => {
    const result = await insertWhere(pushSubscriptions, row('e1'), underCap(1)).run()
    expect(changesOf(result)).toBe(1)
    expect(testDb.select().from(pushSubscriptions).all()).toMatchObject([{ endpoint: 'e1', createdAt: now }])
  })

  it('inserts nothing when the condition fails and reports zero changes', async () => {
    await insertWhere(pushSubscriptions, row('e1'), underCap(1)).run()
    const result = await insertWhere(pushSubscriptions, row('e2'), underCap(1)).run()
    expect(changesOf(result)).toBe(0)
    expect(testDb.select().from(pushSubscriptions).all()).toHaveLength(1)
  })

  it('honours ON CONFLICT DO UPDATE like a plain insert', async () => {
    await insertWhere(pushSubscriptions, row('e1'), undefined).run()
    const result = await insertWhere(pushSubscriptions, { ...row('e1'), keysAuth: 'rotated' }, undefined)
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { keysAuth: sql`excluded.keys_auth` } })
      .run()
    expect(changesOf(result)).toBe(1)
    expect(testDb.select().from(pushSubscriptions).all()).toMatchObject([{ endpoint: 'e1', keysAuth: 'rotated' }])
  })

  it('fills omitted columns from the schema default, or null', async () => {
    await insertWhere(agents, { slug: 'a', name: 'A', createdAt: now }, undefined).run()
    expect(testDb.select().from(agents).all()).toMatchObject([
      { slug: 'a', description: null, runtime: 'local', workspaceHandle: null },
    ])
  })
})

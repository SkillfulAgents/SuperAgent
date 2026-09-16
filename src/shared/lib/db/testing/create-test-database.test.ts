import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { agents } from '../schema'
import { createTestDatabase, testDriverName, type TestDatabase } from './create-test-database'

let handle: TestDatabase | null = null

afterEach(async () => {
  await handle?.close()
  handle = null
})

describe('createTestDatabase', () => {
  it('opens a migrated in-memory database on the driver DB_DRIVER names', async () => {
    handle = await createTestDatabase()
    expect(handle.driver).toBe(testDriverName())

    await handle.db.insert(agents).values({ slug: 'a', name: 'A', createdAt: new Date() }).run()
    const rows = await handle.db.select({ slug: agents.slug }).from(agents).all()
    expect(rows).toEqual([{ slug: 'a' }])
  })

  it('enforces foreign keys on every driver', async () => {
    handle = await createTestDatabase()
    const [row] = await handle.db.all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)
    expect(row.foreign_keys).toBe(1)
  })

  it('gives each call its own database', async () => {
    handle = await createTestDatabase()
    const other = await createTestDatabase()
    try {
      await handle.db.insert(agents).values({ slug: 'a', name: 'A', createdAt: new Date() }).run()
      expect(await other.db.select().from(agents).all()).toEqual([])
    } finally {
      await other.close()
    }
  })
})

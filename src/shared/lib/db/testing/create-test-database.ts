/**
 * A private in-memory database with the bundled migrations applied, on the
 * driver CI asks for. `DB_DRIVER=libsql` runs a test against libsql, the
 * asynchronous, batch-only stand-in for Cloudflare D1; unset, it is
 * better-sqlite3, the desktop driver.
 *
 *   let testDb: AppDatabase
 *   vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
 *   beforeEach(async () => { handle = await createTestDatabase(); testDb = handle.db })
 *   afterEach(() => handle.close())
 */
import { betterSqlite3 } from '../drivers/better-sqlite3'
import { libsql } from '../drivers/libsql'
import type { AppDatabase, DatabaseDriver } from '../drivers/types'
import { migrateFromBundle } from '../open-database'
import type { MigrationMeta } from 'drizzle-orm/migrator'

export type TestDriverName = 'better-sqlite3' | 'libsql'

/** Each driver at a location: a private in-memory database, or a file that several handles can share. */
const TEST_DRIVERS: Record<TestDriverName, (file?: string) => DatabaseDriver> = {
  'better-sqlite3': (file) => betterSqlite3(file ?? ':memory:'),
  libsql: (file) => libsql(file ? `file:${file}` : ':memory:'),
}

/** The driver `DB_DRIVER` names; better-sqlite3 when unset. */
export function testDriverName(): TestDriverName {
  const name = process.env.DB_DRIVER ?? 'better-sqlite3'
  if (!(name in TEST_DRIVERS)) {
    throw new Error(`DB_DRIVER=${name} is not a test driver; use one of ${Object.keys(TEST_DRIVERS).join(', ')}`)
  }
  return name as TestDriverName
}

export interface TestDatabase {
  readonly db: AppDatabase
  readonly driver: TestDriverName
  close(): Promise<void>
}

export interface CreateTestDatabaseOptions {
  migrations?: readonly MigrationMeta[]
  /**
   * A database file instead of a private in-memory database. Two handles on
   * one file stand in for two processes of a deployment sharing a database.
   * Migrating an already-migrated file is a no-op.
   */
  file?: string
}

export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const driver = testDriverName()
  const handle = await TEST_DRIVERS[driver](options.file).open()
  await migrateFromBundle(handle.db, options.migrations)
  return {
    db: handle.db,
    driver,
    close: async () => {
      await handle.close()
    },
  }
}

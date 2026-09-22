/**
 * Opening the database is an explicit boot step, not a side effect of the
 * first query. Each entry point (Electron main, the web server, the perf
 * harness) calls `openDatabase()` before anything else runs; `getDb()` hands
 * out the handle it published and throws before then. The driver is chosen
 * here and nowhere else.
 */
import fs from 'fs'
import path from 'path'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import { getDatabasePath, getDataDir } from '@shared/lib/config/data-dir'
import { captureException } from '@shared/lib/error-reporting'
import { betterSqlite3 } from './drivers/better-sqlite3'
import type { AppDatabase, DatabaseDriver, OpenedDatabase } from './drivers/types'
import { runDataMigrations } from './data-migrations'
import { migrationBundle } from './migrations/bundle'

/** The table drizzle's folder migrator has always written; existing installs continue from it. */
export const MIGRATIONS_TABLE = '__drizzle_migrations'

let opened: OpenedDatabase | null = null
let opening: Promise<AppDatabase> | null = null

/**
 * The app's database. Available once `openDatabase()` has resolved; before
 * that this throws, so a query that runs before the entry point opened the
 * database is a clear error instead of an implicit open with whatever
 * environment happened to be set.
 */
export function getDb(): AppDatabase {
  if (!opened) {
    throw new Error(
      'The database is not open. The entry point must await openDatabase() before anything queries it.',
    )
  }
  return opened.db
}

export function isDatabaseOpen(): boolean {
  return opened !== null
}

/**
 * Apply the migrations in the bundle that the database has not seen, the way
 * drizzle's folder migrator does: compare against the newest row in the
 * migrations table, run the pending ones in one transaction, record each.
 * Works for a synchronous or an asynchronous driver.
 */
export async function migrateFromBundle(db: AppDatabase): Promise<void> {
  // `dialect` and `session` are what drizzle's own `migrate()` reaches for;
  // they are marked internal in its types, so the cast is the same reach.
  const internals = db as unknown as {
    dialect: {
      migrate(
        migrations: MigrationMeta[],
        session: unknown,
        config: { migrationsTable: string },
      ): void | Promise<void>
    }
    session: unknown
  }
  await internals.dialect.migrate([...migrationBundle], internals.session, {
    migrationsTable: MIGRATIONS_TABLE,
  })
}

/** The desktop app's and single-tenant web's database: better-sqlite3 at the configured path. */
function appDatabaseDriver(): DatabaseDriver {
  const dbPath = getDatabasePath()
  const dataDir = getDataDir()
  // Data dir (settings/agents) and DB parent may differ when SUPERAGENT_DB_PATH is set.
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  return betterSqlite3(dbPath)
}

export interface OpenDatabaseOptions {
  /** Defaults to better-sqlite3 at `getDatabasePath()`. */
  driver?: DatabaseDriver
}

/**
 * Open the database, bring its schema up to date from the bundled
 * migrations, run the data migrations, and publish the handle for `getDb()`.
 * A second call while open returns the same handle. A failure is reported as
 * fatal and rethrown: nothing can run without the database.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): Promise<AppDatabase> {
  if (opened) return Promise.resolve(opened.db)
  if (!opening) {
    opening = open(options).finally(() => {
      opening = null
    })
  }
  return opening
}

async function open(options: OpenDatabaseOptions): Promise<AppDatabase> {
  const dbPath = options.driver ? undefined : getDatabasePath()
  const driver = options.driver ?? appDatabaseDriver()

  let handle: OpenedDatabase
  try {
    handle = await driver.open()
  } catch (err) {
    captureException(err, {
      tags: { component: 'database', operation: 'open', driver: driver.name },
      extra: { dbPath, dataDir: getDataDir() },
      level: 'fatal',
    })
    throw err
  }

  try {
    await migrateFromBundle(handle.db)
  } catch (err) {
    captureException(err, {
      tags: { component: 'database', operation: 'migrate', driver: driver.name },
      extra: { dbPath, migrations: migrationBundle.length },
      level: 'fatal',
    })
    await handle.close()
    throw err
  }

  // One-time data moves, after the schema is current and before anything
  // reads: nothing observes a database that is missing one.
  try {
    const applied = await runDataMigrations(handle.db)
    if (applied.length > 0) {
      console.log(`[database] Applied data migrations: ${applied.join(', ')}`)
    }
  } catch (err) {
    captureException(err, {
      tags: { component: 'database', operation: 'data-migrate', driver: driver.name },
      extra: { dbPath },
      level: 'fatal',
    })
    await handle.close()
    throw err
  }

  opened = handle
  return handle.db
}

/** Close the database and forget it; `getDb()` throws again until the next `openDatabase()`. */
export async function closeDatabase(): Promise<void> {
  const handle = opened
  opened = null
  if (handle) await handle.close()
}

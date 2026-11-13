/**
 * The seam between the app and the SQLite driver it runs on.
 *
 * Everything outside `src/shared/lib/db/` sees an `AppDatabase`: drizzle over
 * the app schema, on whichever SQLite-dialect driver opened it. The driver
 * package (better-sqlite3 today, libsql in CI, the Cloudflare drivers later)
 * is imported only by the module under `drivers/` that wraps it, and chosen
 * once, where the database is opened.
 */
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type * as schema from '../schema'

/**
 * The app's database handle. The result kind is left open: better-sqlite3
 * answers synchronously, libsql and the Cloudflare drivers return promises,
 * and `await` accepts both.
 */
export type AppDatabase = BaseSQLiteDatabase<
  'sync' | 'async',
  unknown,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>

/**
 * The synchronous view of the handle, which is what `db` is typed as until
 * every statement is awaited (SUP-865). Run results are opaque here too:
 * read a change count with `changesOf()` from `./batch`.
 */
export type SyncAppDatabase = BaseSQLiteDatabase<
  'sync',
  unknown,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>

/** A handle a driver opened, and the way to close it. */
export interface OpenedDatabase {
  readonly db: AppDatabase
  close(): Promise<void> | void
}

/** Opens the database at one location on one driver package. */
export interface DatabaseDriver {
  /** The driver package's name, for logs and error reports. */
  readonly name: string
  open(): Promise<OpenedDatabase> | OpenedDatabase
}

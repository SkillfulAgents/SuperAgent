/**
 * Data migrations: one-time moves of data into the database that the schema
 * migrations cannot express, such as importing what used to live in files.
 *
 * Each migration is a numbered TypeScript module exporting an id, a name and
 * a synchronous `run`. The runner applies, in id order, every migration the
 * `data_migrations` ledger does not list: it executes `run`, then records the
 * id. The two are not one atomic unit (no driver the app targets lets a
 * transaction stay open across them), so a crash in between re-runs the
 * migration on the next boot, which is why `run` must be idempotent. The
 * runner runs right after the schema migrations while the database is opened,
 * before HTTP binds, so nothing ever observes a database that is missing a
 * move. Migrations are keyed by sequence number, never by app version: a
 * database that is lost re-runs every one of them.
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../schema'
import { dataMigrations } from '../schema'
import { importAgentsFromDirectories } from './0001-import-agents-from-directories'

/** The query surface a migration gets. */
export type DataMigrationDb = Pick<BetterSQLite3Database<typeof schema>, 'select' | 'insert' | 'update' | 'delete'>

export interface DataMigration {
  /** Sequence number; unique, positive, and never reused. */
  readonly id: number
  readonly name: string
  /**
   * Idempotent: the runner records the migration only after `run` returns,
   * so a crash in between runs it again on the next boot, over whatever it
   * already wrote. Skip rows that exist, or insert with `onConflictDoNothing`.
   */
  run(db: DataMigrationDb): void
}

/** Every data migration, in the order they are applied. */
export const DATA_MIGRATIONS: readonly DataMigration[] = [importAgentsFromDirectories]

/**
 * Apply every migration in `migrations` the ledger does not list, in id
 * order, and record each one. Returns the ids applied by this call.
 */
export function runDataMigrations(
  db: BetterSQLite3Database<typeof schema>,
  migrations: readonly DataMigration[] = DATA_MIGRATIONS,
): number[] {
  const ordered = [...migrations].sort((a, b) => a.id - b.id)
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].id === ordered[i - 1].id) {
      throw new Error(`Data migration id ${ordered[i].id} is used twice`)
    }
  }
  const applied = new Set(db.select({ id: dataMigrations.id }).from(dataMigrations).all().map((row) => row.id))
  const appliedNow: number[] = []
  for (const migration of ordered) {
    if (applied.has(migration.id)) continue
    migration.run(db)
    db.insert(dataMigrations).values({ id: migration.id, name: migration.name, appliedAt: new Date() }).run()
    appliedNow.push(migration.id)
  }
  return appliedNow
}

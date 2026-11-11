/**
 * Cloudflare D1, next to better-sqlite3.ts and libsql.ts. D1 runs batches and has no interactive
 * transaction, so it refuses the default migrator, which runs every pending migration in one
 * transaction. This driver applies them as one batch instead, atomic as that transaction is.
 */
import { drizzle } from 'drizzle-orm/d1'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import * as schema from '../schema'
import { MIGRATIONS_TABLE } from '../open-database'
import type { DatabaseDriver } from './types'

/** The part of a Workers D1 binding this file calls; drizzle's D1 driver calls the rest. */
export interface D1Binding {
  prepare(query: string): D1Statement
  batch(statements: D1Statement[]): Promise<unknown>
}

interface D1Statement {
  raw(): Promise<unknown[][]>
}

export function d1(binding: D1Binding): DatabaseDriver {
  return {
    name: 'd1',
    // Cloudflare's documented limit for one D1 query.
    maxBoundParameters: 100,
    open: () => ({ db: drizzle(binding as Parameters<typeof drizzle>[0], { schema }), close: () => {} }),
    migrateSchema: (_db, migrations) => migrateD1(binding, migrations),
  }
}

/**
 * Applies the migrations the database has not seen as one batch. Same journal table and rule as
 * drizzle's migrator, so a database it migrated continues here: a migration is pending when it is
 * newer than the newest journal row.
 */
export async function migrateD1(binding: D1Binding, migrations: readonly MigrationMeta[]): Promise<void> {
  const table = `"${MIGRATIONS_TABLE.replaceAll('"', '""')}"`
  await binding.prepare(`CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`).raw()
  const [last] = await binding.prepare(`SELECT created_at FROM ${table} ORDER BY created_at DESC LIMIT 1`).raw()
  const lastMillis = last ? Number(last[0]) : -Infinity

  const statements: string[] = []
  for (const migration of migrations) {
    if (migration.folderMillis <= lastMillis) continue
    if (!/^[0-9a-f]+$/.test(migration.hash) || !Number.isInteger(migration.folderMillis)) {
      throw new Error(`Malformed migration journal entry ${migration.hash}`)
    }
    for (const statement of migration.sql) {
      if (statement.trim()) statements.push(statement)
    }
    // Inlined, not bound: the batch runs plain statements.
    statements.push(`INSERT INTO ${table} ("hash", "created_at") VALUES ('${migration.hash}', ${migration.folderMillis})`)
  }
  if (statements.length > 0) await binding.batch(statements.map((statement) => binding.prepare(statement)))
}

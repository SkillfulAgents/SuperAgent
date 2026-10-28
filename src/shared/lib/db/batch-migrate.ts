/**
 * The bundled schema migrations for a driver with a batch and no interactive
 * transaction (D1, libsql): the pending migrations and their journal rows
 * commit together or not at all. Same table and rule as drizzle's migrator,
 * so a database it migrated continues here: a migration is pending when it is
 * newer than the newest journal row.
 */
import type { MigrationMeta } from 'drizzle-orm/migrator'

/** The driver's own client, below drizzle. */
export interface RawBatchClient {
  /** Runs one statement; rows come back as arrays of column values. */
  query(sql: string): Promise<unknown[][]>
  /** Runs the statements in order as one atomic unit. */
  batch(statements: string[]): Promise<void>
}

export async function migrateInBatch(
  client: RawBatchClient,
  migrations: readonly MigrationMeta[],
  migrationsTable: string,
): Promise<void> {
  const table = `"${migrationsTable.replaceAll('"', '""')}"`
  await client.query(`CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`)
  const [last] = await client.query(`SELECT created_at FROM ${table} ORDER BY created_at DESC LIMIT 1`)
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
    // Inlined, not bound: D1's batch runs plain statements.
    statements.push(`INSERT INTO ${table} ("hash", "created_at") VALUES ('${migration.hash}', ${migration.folderMillis})`)
  }
  if (statements.length > 0) await client.batch(statements)
}

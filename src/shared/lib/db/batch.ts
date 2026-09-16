/**
 * Multi-statement writes without an interactive transaction.
 *
 * Cloudflare D1 and Durable Object SQLite offer two things: a batch of
 * statements that commits or aborts together, and single statements whose
 * change count tells the caller what happened. There is no `BEGIN … COMMIT`
 * a caller can hold open while it reads and decides. Every write in the app
 * is expressed in those terms so the same code runs on better-sqlite3
 * (desktop, single-tenant web), libsql (CI) and the Cloudflare drivers:
 *
 * - A pure multi-statement write is a `batch()`.
 * - A read-then-decide write is one conditional statement (`UPDATE … WHERE`
 *   with a subquery, `INSERT … SELECT … WHERE`, a compare-and-set) whose
 *   change count, read through `changesOf()`, is the decision.
 *
 * On better-sqlite3 a batch is a synchronous transaction, so behaviour there
 * is unchanged. `db.transaction` is fenced by the `no-db-transaction` lint
 * rule; this module is the only place it may appear.
 */
import { getTableColumns, is, sql, SQL, type SQLWrapper } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { db } from './index'

/** A drizzle insert, update or delete builder: anything that can `run()`. */
export interface BatchStatement extends SQLWrapper {
  run(): unknown
}

/**
 * Run `statements` in order as one atomic unit: all commit or none do. The
 * driver run results come back in the same order; read a change count with
 * `changesOf()`. Statements run sequentially, so a later statement sees the
 * effect of an earlier one (a delete before a capped insert, for example).
 */
export async function batch(statements: readonly BatchStatement[]): Promise<unknown[]> {
  if (statements.length === 0) return []
  const handle = db as unknown as {
    batch?: (statements: readonly BatchStatement[]) => Promise<unknown[]>
    transaction: <T>(work: () => T) => T
  }
  // libsql, D1 and Durable Object SQLite: the driver's own batch.
  if (typeof handle.batch === 'function') return handle.batch(statements)
  // better-sqlite3: one connection, one synchronous transaction.
  return handle.transaction(() => statements.map((statement) => statement.run()))
}

/**
 * Rows changed by an insert, update or delete, whatever the driver reports:
 * better-sqlite3 `{ changes }`, libsql `{ rowsAffected }`, D1 `{ meta: { changes } }`.
 */
export function changesOf(result: unknown): number {
  if (result && typeof result === 'object') {
    const shape = result as { changes?: unknown; rowsAffected?: unknown; meta?: { changes?: unknown } }
    if (typeof shape.changes === 'number') return shape.changes
    if (typeof shape.rowsAffected === 'number') return shape.rowsAffected
    if (typeof shape.meta?.changes === 'number') return shape.meta.changes
  }
  throw new Error(`changesOf: unrecognised run result ${JSON.stringify(result)}`)
}

/**
 * `INSERT INTO table (…) SELECT … WHERE condition`: the row is inserted only
 * when `condition` holds at execution time, evaluated by the driver in the
 * same statement, so there is no window between a check and the write. Chain
 * `.onConflictDoUpdate()` / `.onConflictDoNothing()` as on any insert; zero
 * changes means the condition was false.
 *
 * Every column is listed (that is how drizzle renders an insert-select), so
 * a column the row omits takes its schema default, or null.
 */
export function insertWhere<TTable extends SQLiteTable>(
  table: TTable,
  row: TTable['$inferInsert'],
  condition: SQL | undefined,
) {
  const values = Object.entries(getTableColumns(table))
    // Same rule drizzle's `values()` applies: generated-always columns are not listed.
    .filter(([, column]) => column.generated === undefined || column.generated.type === 'byDefault')
    .map(([key, column]) => {
      const value = (row as Record<string, unknown>)[key]
      if (value !== undefined) return is(value, SQL) ? value : sql.param(value, column)
      if (column.default !== undefined && column.default !== null) {
        return is(column.default, SQL) ? column.default : sql.param(column.default, column)
      }
      if (column.defaultFn !== undefined) {
        const generated = column.defaultFn()
        return is(generated, SQL) ? generated : sql.param(generated, column)
      }
      return sql`null`
    })
  // SQLite needs a WHERE between an insert-select and ON CONFLICT (parsing ambiguity).
  return db.insert(table).select(sql`select ${sql.join(values, sql`, `)} where ${condition ?? sql`1`}`)
}

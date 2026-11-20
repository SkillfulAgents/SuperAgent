/**
 * The most parameters one statement may bind on the open database's driver.
 * `openDatabase()` sets it from the driver before migrations run, so code that
 * splits a write into statements reads it here instead of knowing the driver.
 */
import { inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm'

/** SQLite's own limit (SQLITE_MAX_VARIABLE_NUMBER) since 3.32. */
const SQLITE_MAX_BOUND_PARAMETERS = 32766

let limit = SQLITE_MAX_BOUND_PARAMETERS

export function maxBoundParameters(): number {
  return limit
}

/** Unset means SQLite's own limit. */
export function setMaxBoundParameters(value: number | undefined): void {
  limit = value ?? SQLITE_MAX_BOUND_PARAMETERS
}

// These SQLite columns store plain IDs. Other column types can apply a
// Drizzle encoder when bound individually (JSON text and timestamps do).
type IdColumn =
  | AnyColumn<{ columnType: 'SQLiteText'; data: string }>
  | AnyColumn<{ columnType: 'SQLiteInteger' | 'SQLiteReal'; data: number }>

/**
 * Bind each text or safe integer ID directly while the whole statement fits.
 * `otherParams` counts every binding outside this list, including SET values.
 * An oversized list uses one parameter, so the caller must leave that slot free.
 */
export function inList<TColumn extends IdColumn>(
  column: TColumn,
  values: readonly NoInfer<TColumn['_']['data']>[],
  { otherParams }: { otherParams: number },
): SQL {
  if (values.length <= maxBoundParameters() - otherParams) return inArray(column, values)
  // Match the UTF-8 conversion a driver applies to individually bound strings.
  const ids = values.map(id => typeof id === 'string' ? id.toWellFormed() : id)
  return inArray(column, sql`(select value from json_each(${JSON.stringify(ids)}))`)
}

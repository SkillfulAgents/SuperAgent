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
 * Build the complete statement around an ID predicate. Drizzle's compiled
 * parameters include SET values, joins, subqueries and repeated predicates.
 * The callback builds the query once. Only the returned query is executed.
 */
export function withInList<TColumn extends IdColumn, TQuery extends { toSQL(): { params: unknown[] } }>(
  column: TColumn,
  values: readonly NoInfer<TColumn['_']['data']>[] | null | undefined,
  build: (matches: SQL | undefined) => TQuery,
): TQuery {
  if (!values) return build(undefined)
  if (values.length <= 1) return build(inArray(column, values))

  const limit = maxBoundParameters()
  const packed = () => {
    // Match the UTF-8 conversion a driver applies to individually bound strings.
    const ids = values.map(id => typeof id === 'string' ? id.toWellFormed() : id)
    return inArray(column, sql`(select value from json_each(${JSON.stringify(ids)}))`)
  }
  if (values.length > limit) return build(packed())

  // Compile a single placeholder for the list so counting a large list
  // doesn't render thousands of parameters twice. Drizzle keeps the
  // placeholder object in params at each occurrence, even in a subquery.
  const marker = sql.placeholder('inList')
  let predicate = inArray(column, [marker])
  const query = build(sql`${{ getSQL: () => predicate }}`)
  const { params } = query.toSQL()
  const occurrences = params.filter(param => param === marker).length
  const directCount = params.length + occurrences * (values.length - 1)
  predicate = directCount <= limit ? inArray(column, values) : packed()
  return query
}

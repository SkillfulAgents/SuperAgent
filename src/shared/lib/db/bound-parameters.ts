/**
 * The most parameters one statement may bind on the open database's driver.
 * `openDatabase()` sets it from the driver before migrations run, so code that
 * splits a write into statements reads it here instead of knowing the driver.
 */
import { inArray, sql, type Column, type SQL } from 'drizzle-orm'

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


/**
 * `inArray` that binds one parameter however long `values` is: the list
 * travels as one JSON array read with `json_each`, not as `IN (?, ?, …)`.
 * Use it for any list that can grow, so no caller has to split it by
 * {@link maxBoundParameters}.
 */
export function inList(column: Column, values: readonly (string | number)[]): SQL {
  return inArray(column, sql`(select value from json_each(${JSON.stringify(values)}))`)
}

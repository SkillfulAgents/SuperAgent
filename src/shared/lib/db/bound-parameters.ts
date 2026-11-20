/**
 * The most parameters one statement may bind on the open database's driver.
 * `openDatabase()` sets it from the driver before migrations run, so code that
 * splits a write into statements reads it here instead of knowing the driver.
 */

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

/** `values` in parts small enough for one statement that binds `otherParameters` more besides them. */
export function chunksWithinBoundParameters<T>(values: readonly T[], otherParameters: number): T[][] {
  const size = maxBoundParameters() - otherParameters
  const out: T[][] = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

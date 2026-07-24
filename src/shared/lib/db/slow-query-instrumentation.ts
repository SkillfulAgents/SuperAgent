import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import type Database from 'better-sqlite3'

export const DB_SLOW_QUERY_LOG_MS_ENV = 'DB_SLOW_QUERY_LOG_MS'
export const EVENT_LOOP_DELAY_LOG_INTERVAL_MS = 30_000

type SqliteDatabase = InstanceType<typeof Database>
type SqliteStatement = ReturnType<SqliteDatabase['prepare']>

// Positive ms threshold from env; unset/empty/invalid => instrumentation off.
export function parseSlowQueryLogMs(raw: string | undefined = process.env[DB_SLOW_QUERY_LOG_MS_ENV]): number | null {
  if (raw == null || raw.trim() === '') return null
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) return null
  return ms
}

function logSlowQuery(payload: {
  op: string
  durationMs: number
  sql?: string
  thresholdMs: number
}): void {
  const stack = new Error('db_slow_query').stack?.split('\n').slice(2, 10).join('\n')
  console.warn(
    JSON.stringify({
      event: 'db_slow_query',
      op: payload.op,
      duration_ms: Math.round(payload.durationMs * 1000) / 1000,
      threshold_ms: payload.thresholdMs,
      sql: payload.sql?.slice(0, 500),
      stack,
    }),
  )
}

function timedCall<T>(
  op: string,
  thresholdMs: number,
  sql: string | undefined,
  fn: () => T,
): T {
  const start = performance.now()
  try {
    return fn()
  } finally {
    const durationMs = performance.now() - start
    if (durationMs >= thresholdMs) {
      logSlowQuery({ op, durationMs, sql, thresholdMs })
    }
  }
}

function wrapStatement(stmt: SqliteStatement, sql: string, thresholdMs: number): SqliteStatement {
  const methods = ['run', 'get', 'all', 'iterate'] as const
  for (const method of methods) {
    const original = (stmt[method] as (...args: unknown[]) => unknown).bind(stmt)
    ;(stmt as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      timedCall(`statement.${method}`, thresholdMs, sql, () => original(...args))
  }
  return stmt
}

let eventLoopMonitorStarted = false
let eventLoopHistogram: IntervalHistogram | null = null
let eventLoopTimer: ReturnType<typeof setInterval> | null = null

export function startEventLoopDelayLogger(
  intervalMs: number = EVENT_LOOP_DELAY_LOG_INTERVAL_MS,
): void {
  if (eventLoopMonitorStarted) return
  eventLoopMonitorStarted = true

  eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 })
  eventLoopHistogram.enable()

  eventLoopTimer = setInterval(() => {
    const h = eventLoopHistogram
    if (!h) return
    console.warn(
      JSON.stringify({
        event: 'event_loop_delay',
        p50_ms: Math.round((h.percentile(50) / 1e6) * 1000) / 1000,
        p99_ms: Math.round((h.percentile(99) / 1e6) * 1000) / 1000,
        max_ms: Math.round((h.max / 1e6) * 1000) / 1000,
        mean_ms: Math.round((h.mean / 1e6) * 1000) / 1000,
      }),
    )
    h.reset()
  }, intervalMs)
  eventLoopTimer.unref?.()
}

/** Test-only: stop the interval so vitest can exit cleanly. */
export function stopEventLoopDelayLoggerForTests(): void {
  if (eventLoopTimer) {
    clearInterval(eventLoopTimer)
    eventLoopTimer = null
  }
  if (eventLoopHistogram) {
    eventLoopHistogram.disable()
    eventLoopHistogram = null
  }
  eventLoopMonitorStarted = false
}

export function instrumentSqliteIfEnabled(
  sqlite: SqliteDatabase,
  thresholdMs: number | null = parseSlowQueryLogMs(),
): SqliteDatabase {
  if (thresholdMs == null) return sqlite

  startEventLoopDelayLogger()
  console.warn(
    JSON.stringify({
      event: 'db_slow_query_instrumentation_enabled',
      threshold_ms: thresholdMs,
      event_loop_log_interval_ms: EVENT_LOOP_DELAY_LOG_INTERVAL_MS,
    }),
  )

  const originalPrepare = sqlite.prepare.bind(sqlite)
  sqlite.prepare = ((sql: string, ...rest: unknown[]) => {
    const stmt = (originalPrepare as (...args: unknown[]) => SqliteStatement)(sql, ...rest)
    return wrapStatement(stmt, sql, thresholdMs)
  }) as typeof sqlite.prepare

  const originalExec = sqlite.exec.bind(sqlite)
  sqlite.exec = ((sql: string) =>
    timedCall('db.exec', thresholdMs, sql, () => originalExec(sql))) as typeof sqlite.exec

  const originalPragma = sqlite.pragma.bind(sqlite)
  sqlite.pragma = ((source: string, options?: unknown) =>
    timedCall('db.pragma', thresholdMs, source, () =>
      (originalPragma as (s: string, o?: unknown) => unknown)(source, options),
    )) as typeof sqlite.pragma

  const originalTransaction = sqlite.transaction.bind(sqlite)
  sqlite.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const wrapped = originalTransaction((...args: unknown[]) =>
      timedCall('db.transaction', thresholdMs, undefined, () => fn(...args)),
    )
    return wrapped
  }) as typeof sqlite.transaction

  return sqlite
}

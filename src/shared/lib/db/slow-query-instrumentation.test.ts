import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  instrumentSqliteIfEnabled,
  parseSlowQueryLogMs,
  stopEventLoopDelayLoggerForTests,
} from './slow-query-instrumentation'

afterEach(() => {
  stopEventLoopDelayLoggerForTests()
  vi.restoreAllMocks()
})

describe('parseSlowQueryLogMs', () => {
  it('returns null when unset or blank', () => {
    expect(parseSlowQueryLogMs(undefined)).toBeNull()
    expect(parseSlowQueryLogMs('')).toBeNull()
    expect(parseSlowQueryLogMs('   ')).toBeNull()
  })

  it('returns null for non-positive or non-finite values', () => {
    expect(parseSlowQueryLogMs('0')).toBeNull()
    expect(parseSlowQueryLogMs('-1')).toBeNull()
    expect(parseSlowQueryLogMs('nope')).toBeNull()
  })

  it('parses a positive threshold', () => {
    expect(parseSlowQueryLogMs('250')).toBe(250)
    expect(parseSlowQueryLogMs('1.5')).toBe(1.5)
  })
})

describe('instrumentSqliteIfEnabled', () => {
  it('is a no-op when threshold is null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sqlite = new Database(':memory:')
    instrumentSqliteIfEnabled(sqlite, null)
    expect(sqlite.prepare('select 1 as n').get()).toEqual({ n: 1 })
    expect(warn).not.toHaveBeenCalled()
    sqlite.close()
  })

  it('logs statement ops that exceed the threshold', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sqlite = instrumentSqliteIfEnabled(new Database(':memory:'), 1)
    // busy_timeout / sleep via recursive CTE is awkward; force wall time with a JS busy loop
    // inside a user function registered on the connection.
    sqlite.function('busy_ms', (ms: number) => {
      const end = Date.now() + Number(ms)
      while (Date.now() < end) {
        /* spin */
      }
      return 1
    })
    const row = sqlite.prepare('select busy_ms(20) as n').get() as { n: number }
    expect(row.n).toBe(1)

    const slowLines = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('"event":"db_slow_query"'))
    expect(slowLines.length).toBeGreaterThan(0)
    const payload = JSON.parse(slowLines[0]!) as {
      event: string
      op: string
      duration_ms: number
      threshold_ms: number
      sql?: string
    }
    expect(payload.event).toBe('db_slow_query')
    expect(payload.op).toBe('statement.get')
    expect(payload.duration_ms).toBeGreaterThanOrEqual(1)
    expect(payload.threshold_ms).toBe(1)
    expect(payload.sql).toContain('busy_ms')
    sqlite.close()
  })
})

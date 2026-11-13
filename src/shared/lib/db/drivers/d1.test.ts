import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import { closeDatabase, getDb, MIGRATIONS_TABLE, openDatabase } from '../open-database'
import { migrationBundle } from '../migrations/bundle'
import { dataMigrations } from '../schema'
import { d1, migrateD1, type D1Binding } from './d1'

/** A D1 binding over an in-memory SQLite database: statements, binds and atomic batches, as Workers runs them. */
function memoryD1() {
  const sqlite = new Database(':memory:')
  // D1 enforces foreign keys.
  sqlite.pragma('foreign_keys = ON')
  const args = (params: unknown[]) => params.map((value) => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value))

  class Statement {
    constructor(
      private readonly query: string,
      private readonly params: unknown[] = [],
    ) {}

    bind(...params: unknown[]): Statement {
      return new Statement(this.query, params)
    }

    async all() {
      return { results: this.rows(), success: true, meta: {} }
    }

    async raw(): Promise<unknown[][]> {
      const statement = sqlite.prepare(this.query)
      if (!statement.reader) {
        statement.run(...args(this.params))
        return []
      }
      return statement.raw(true).all(...args(this.params)) as unknown[][]
    }

    async first(column?: string) {
      const row = this.rows()[0]
      if (!row) return null
      return column === undefined ? row : (row[column] ?? null)
    }

    async run() {
      return { results: [], success: true, meta: this.execute() }
    }

    /** What the statement answers inside a batch. */
    answer() {
      return sqlite.prepare(this.query).reader ? { results: this.rows(), success: true, meta: {} } : { results: [], success: true, meta: this.execute() }
    }

    private rows(): Record<string, unknown>[] {
      const statement = sqlite.prepare(this.query)
      if (!statement.reader) {
        statement.run(...args(this.params))
        return []
      }
      return statement.all(...args(this.params)) as Record<string, unknown>[]
    }

    private execute() {
      const info = sqlite.prepare(this.query).run(...args(this.params))
      return { changes: info.changes, last_row_id: Number(info.lastInsertRowid) }
    }
  }

  const binding = {
    prepare: (query: string) => new Statement(query),
    batch: async (statements: Statement[]) => sqlite.transaction(() => statements.map((statement) => statement.answer()))(),
  }
  return { sqlite, binding: binding as unknown as D1Binding & typeof binding }
}

const journalRows = (sqlite: Database.Database) => sqlite.prepare(`SELECT COUNT(*) AS n FROM "${MIGRATIONS_TABLE}"`).get()

let tmpRoot: string
let prevDataDir: string | undefined

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-d1-'))
  prevDataDir = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = path.join(tmpRoot, 'data')
})

afterEach(async () => {
  await closeDatabase()
  if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('the D1 driver', () => {
  it('brings a new database to the bundled schema in one batch', async () => {
    const { sqlite, binding } = memoryD1()
    const batch = vi.spyOn(binding, 'batch')

    await migrateD1(binding, migrationBundle)

    expect(batch).toHaveBeenCalledTimes(1)
    expect(journalRows(sqlite)).toEqual({ n: migrationBundle.length })
  })

  it('opens a migrated database without migrating it again', async () => {
    const { binding } = memoryD1()
    await migrateD1(binding, migrationBundle)
    const prepare = vi.spyOn(binding, 'prepare')

    await openDatabase({ driver: d1(binding), migrate: false })

    expect(prepare).not.toHaveBeenCalled()
    expect(await getDb().select({ id: dataMigrations.id }).from(dataMigrations).all()).toEqual([])
  })

  it('runs nothing again on a database it brought up to date', async () => {
    const { sqlite, binding } = memoryD1()
    await migrateD1(binding, migrationBundle)
    const batch = vi.spyOn(binding, 'batch')

    await migrateD1(binding, migrationBundle)

    expect(batch).not.toHaveBeenCalled()
    expect(journalRows(sqlite)).toEqual({ n: migrationBundle.length })
  })

  it('applies none of the pending migrations when one of them fails', async () => {
    const { sqlite, binding } = memoryD1()
    const migrations: MigrationMeta[] = [
      { sql: ['CREATE TABLE first_table (id INTEGER PRIMARY KEY)'], folderMillis: 1, hash: 'aa', bps: true },
      { sql: ['CREATE TABLE second_table (id INTEGER PRIMARY KEY'], folderMillis: 2, hash: 'bb', bps: true },
    ]

    await expect(migrateD1(binding, migrations)).rejects.toThrow()

    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'first_table'").all()).toEqual([])
    expect(journalRows(sqlite)).toEqual({ n: 0 })
  })
})

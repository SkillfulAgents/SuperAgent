import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import * as schema from './schema'

vi.mock('./data-migrations', () => ({
  runDataMigrations: vi.fn(async () => []),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

import { closeDatabase, getDb, isDatabaseOpen, MIGRATIONS_TABLE, openDatabase } from './open-database'
import { betterSqlite3 } from './drivers/better-sqlite3'
import { runDataMigrations } from './data-migrations'
import { captureException } from '@shared/lib/error-reporting'

let tmpRoot: string
let prevDataDir: string | undefined
let prevDbPath: string | undefined

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-open-database-'))
  prevDataDir = process.env.SUPERAGENT_DATA_DIR
  prevDbPath = process.env.SUPERAGENT_DB_PATH
  process.env.SUPERAGENT_DATA_DIR = path.join(tmpRoot, 'data')
  process.env.SUPERAGENT_DB_PATH = path.join(tmpRoot, 'nested', 'sqlite', 'superagent.db')
  vi.mocked(runDataMigrations).mockClear()
  vi.mocked(captureException).mockClear()
})

afterEach(async () => {
  await closeDatabase()
  if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  if (prevDbPath === undefined) delete process.env.SUPERAGENT_DB_PATH
  else process.env.SUPERAGENT_DB_PATH = prevDbPath
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

async function migrationRows(db: ReturnType<typeof getDb>) {
  return db.all<{ hash: string; created_at: number }>(
    // Applied order, which is journal order (the journal is not sorted by time).
    sql`SELECT hash, created_at FROM ${sql.identifier(MIGRATIONS_TABLE)} ORDER BY id`,
  )
}

describe('openDatabase', () => {
  it('throws from getDb() until the database is opened, then hands out the handle', async () => {
    expect(isDatabaseOpen()).toBe(false)
    expect(() => getDb()).toThrow('await openDatabase()')

    const db = await openDatabase()

    expect(isDatabaseOpen()).toBe(true)
    expect(getDb()).toBe(db)
    expect(await openDatabase()).toBe(db)
  })

  it('creates the data dir and the SUPERAGENT_DB_PATH parent before opening the file', async () => {
    const dbParent = path.join(tmpRoot, 'nested', 'sqlite')
    expect(fs.existsSync(dbParent)).toBe(false)

    await openDatabase()

    expect(fs.existsSync(path.join(tmpRoot, 'data'))).toBe(true)
    expect(fs.existsSync(path.join(dbParent, 'superagent.db'))).toBe(true)
  })

  it('migrates a fresh database from the bundle, recording every migration the folder migrator would', async () => {
    const db = await openDatabase()

    const fromFolder = readMigrationFiles({ migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    expect(await migrationRows(db)).toEqual(fromFolder.map((m) => ({ hash: m.hash, created_at: m.folderMillis })))
    expect(await db.select().from(schema.dataMigrations).all()).toEqual([])
    expect(runDataMigrations).toHaveBeenCalledWith(db)
  })

  it('continues an existing install from the migrations it already has', async () => {
    // An install from before the last migration: everything but the newest
    // row, written by drizzle's folder migrator under the same table name.
    const dbPath = process.env.SUPERAGENT_DB_PATH!
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const fromFolder = readMigrationFiles({ migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    const older = await betterSqlite3(dbPath).open()
    const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')
    const { drizzle } = await import('drizzle-orm/better-sqlite3')
    const Database = (await import('better-sqlite3')).default
    await older.close()
    const previousRelease = fs.mkdtempSync(path.join(tmpRoot, 'previous-'))
    fs.cpSync(path.join(process.cwd(), 'src/shared/lib/db/migrations'), previousRelease, { recursive: true })
    const journalPath = path.join(previousRelease, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    journal.entries = journal.entries.slice(0, -1)
    fs.writeFileSync(journalPath, JSON.stringify(journal))
    const sqlite = new Database(dbPath)
    migrate(drizzle(sqlite), { migrationsFolder: previousRelease })
    const before = sqlite.prepare(`SELECT count(*) AS n FROM ${MIGRATIONS_TABLE}`).get() as { n: number }
    sqlite.close()
    expect(before.n).toBe(fromFolder.length - 1)

    const db = await openDatabase()

    expect(await migrationRows(db)).toEqual(fromFolder.map((m) => ({ hash: m.hash, created_at: m.folderMillis })))
  })

  it('reports a failed open as fatal and rethrows, leaving the database closed', async () => {
    const failing = {
      name: 'failing',
      open() {
        throw new Error('disk on fire')
      },
    }

    await expect(openDatabase({ driver: failing })).rejects.toThrow('disk on fire')

    expect(isDatabaseOpen()).toBe(false)
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ level: 'fatal', tags: expect.objectContaining({ operation: 'open', driver: 'failing' }) }),
    )
  })

  it('reports a failed data migration as fatal, closes the handle, and lets the next open try again', async () => {
    vi.mocked(runDataMigrations).mockRejectedValueOnce(new Error('move failed'))

    await expect(openDatabase()).rejects.toThrow('move failed')
    expect(isDatabaseOpen()).toBe(false)
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ level: 'fatal', tags: expect.objectContaining({ operation: 'data-migrate' }) }),
    )

    await expect(openDatabase()).resolves.toBeDefined()
    expect(isDatabaseOpen()).toBe(true)
  })

  it('opens once when two callers race', async () => {
    const [a, b] = await Promise.all([openDatabase(), openDatabase()])
    expect(a).toBe(b)
    expect(runDataMigrations).toHaveBeenCalledTimes(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockPragma = vi.fn()
const mockClose = vi.fn()
vi.mock('better-sqlite3', () => ({
  default: vi.fn(function MockDatabase(this: { pragma: typeof mockPragma; close: typeof mockClose }) {
    this.pragma = mockPragma
    this.close = mockClose
  }),
}))

vi.mock('drizzle-orm/better-sqlite3', () => ({
  drizzle: vi.fn(() => ({})),
}))

vi.mock('drizzle-orm/better-sqlite3/migrator', () => ({
  migrate: vi.fn(),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

describe('initDb parent directory', () => {
  let tmpRoot: string
  let prevDataDir: string | undefined
  let prevDbPath: string | undefined

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-db-path-'))
    prevDataDir = process.env.SUPERAGENT_DATA_DIR
    prevDbPath = process.env.SUPERAGENT_DB_PATH
    process.env.SUPERAGENT_DATA_DIR = path.join(tmpRoot, 'data')
    process.env.SUPERAGENT_DB_PATH = path.join(tmpRoot, 'nested', 'sqlite', 'superagent.db')
    vi.resetModules()
  })

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
    if (prevDbPath === undefined) delete process.env.SUPERAGENT_DB_PATH
    else process.env.SUPERAGENT_DB_PATH = prevDbPath
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    vi.resetModules()
  })

  it('creates the SUPERAGENT_DB_PATH parent before opening SQLite', async () => {
    const dbParent = path.join(tmpRoot, 'nested', 'sqlite')
    expect(fs.existsSync(dbParent)).toBe(false)

    const Database = (await import('better-sqlite3')).default
    const { sqlite } = await import('./index')
    // Touch the proxy to trigger initDb
    void sqlite.close

    expect(fs.existsSync(dbParent)).toBe(true)
    expect(fs.existsSync(process.env.SUPERAGENT_DATA_DIR!)).toBe(true)
    expect(Database).toHaveBeenCalledWith(process.env.SUPERAGENT_DB_PATH)
  })
})

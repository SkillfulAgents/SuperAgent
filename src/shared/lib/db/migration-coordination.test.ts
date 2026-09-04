/**
 * ELECTRON-H9 / ELECTRON-HS / ELECTRON-9T / ELECTRON-HW / ELECTRON-KV —
 * SQLite startup contention.
 *
 * drizzle's better-sqlite3 migrator reads "last applied migration" BEFORE it
 * opens its transaction, then applies every newer migration inside it. Two
 * processes starting together therefore both decide to apply the same files:
 *
 *   - with no busy timeout the loser dies immediately on "database is locked"
 *     (H9/HS/9T/HW);
 *   - with a busy timeout it waits, wakes after the winner commits, and
 *     replays applied DDL → "duplicate column name: creation_method" (KV,
 *     migration 0033).
 *
 * So the busy timeout alone just trades one failure for the other. These
 * tests pin down all three parts of the fix: bounded lock waiting, an
 * inter-process migration lock with stale recovery, and a NARROW journal
 * repair that never blanket-ignores a duplicate column.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { withMigrationLock, MigrationLockTimeoutError } from './migration-lock'
import {
  columnMatches,
  extractDuplicateColumn,
  isDuplicateColumnError,
  parseAddColumnMigration,
  repairJournalForAppliedMigration,
} from './migration-repair'
import { runMigrations, SQLITE_BUSY_TIMEOUT_MS } from './index'
import { classifyDatabaseFilesystem, describeUnsupportedFilesystem } from './filesystem-class'

const MIGRATIONS_FOLDER = path.resolve(__dirname, 'migrations')
const REPO_NODE_MODULES = path.resolve(__dirname, '../../../../node_modules')

let tmpDir: string
let dbPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-db-test-'))
  dbPath = path.join(tmpDir, 'superagent.db')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Runs `source` in a real second process; resolves with its exit code. */
function runChild(source: string): { done: Promise<number> } {
  const scriptPath = path.join(tmpDir, `child-${Math.random().toString(36).slice(2)}.cjs`)
  fs.writeFileSync(scriptPath, source)
  const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const done = new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(0) : reject(new Error(`child exited ${code}: ${stderr}`))))
  })
  return { done }
}

// ---------------------------------------------------------------------------
// Bounded lock waiting (busy_timeout)
// ---------------------------------------------------------------------------

describe('SQLite busy timeout', () => {
  it('lets a second connection wait out another process\'s write transaction', async () => {
    // A first process holds a write transaction for 400ms.
    const holder = runChild(`
      const Database = require(${JSON.stringify(path.join(REPO_NODE_MODULES, 'better-sqlite3'))});
      const db = new Database(${JSON.stringify(dbPath)});
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO t (v) VALUES (?)').run('from-holder');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 400);
    `)
    // Wait for the child to actually hold the lock.
    await new Promise((resolve) => setTimeout(resolve, 250))

    const patient = new Database(dbPath)
    patient.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
    // Blocks until the holder commits, then succeeds.
    patient.prepare('INSERT INTO t (v) VALUES (?)').run('from-patient')
    const rows = patient.prepare('SELECT v FROM t ORDER BY id').all() as { v: string }[]
    patient.close()

    expect(rows.map((r) => r.v)).toEqual(['from-holder', 'from-patient'])
    await holder.done
  })

  it('fails immediately without a busy timeout (the pre-fix behaviour)', async () => {
    const holder = runChild(`
      const Database = require(${JSON.stringify(path.join(REPO_NODE_MODULES, 'better-sqlite3'))});
      const db = new Database(${JSON.stringify(dbPath)});
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO t (v) VALUES (?)').run('from-holder');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 400);
    `)
    await new Promise((resolve) => setTimeout(resolve, 250))

    const impatient = new Database(dbPath)
    impatient.pragma('busy_timeout = 0')
    expect(() => impatient.prepare('INSERT INTO t (v) VALUES (?)').run('nope')).toThrow(/locked/i)
    impatient.close()

    await holder.done
  })
})

// ---------------------------------------------------------------------------
// Inter-process migration lock
// ---------------------------------------------------------------------------

describe('withMigrationLock', () => {
  it('serialises against another process holding the lock file', async () => {
    const lockPath = `${dbPath}.migrate.lock`
    const releasedAtPath = path.join(tmpDir, 'released-at')
    const holder = runChild(`
      const fs = require('fs');
      const fd = fs.openSync(${JSON.stringify(lockPath)}, 'wx');
      fs.writeFileSync(fd, 'child.owner');
      fs.closeSync(fd);
      setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(releasedAtPath)}, String(Date.now()));
        fs.rmSync(${JSON.stringify(lockPath)}, { force: true });
      }, 400);
    `)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(fs.existsSync(lockPath)).toBe(true)

    // Blocks (synchronously) until the other process releases.
    const acquiredAt = withMigrationLock(dbPath, () => Date.now())
    const releasedAt = Number(fs.readFileSync(releasedAtPath, 'utf-8'))

    expect(acquiredAt).toBeGreaterThanOrEqual(releasedAt)
    expect(fs.existsSync(lockPath)).toBe(false) // released again
    await holder.done
  })

  it('times out instead of blocking forever on a live lock', () => {
    fs.writeFileSync(`${dbPath}.migrate.lock`, 'someone.else')
    expect(() => withMigrationLock(dbPath, () => 'never', { timeoutMs: 150, retryIntervalMs: 10 }))
      .toThrow(MigrationLockTimeoutError)
  })

  it('steals a stale lock left behind by a crashed process', () => {
    const lockPath = `${dbPath}.migrate.lock`
    fs.writeFileSync(lockPath, 'dead.process')
    const old = Date.now() / 1000 - 3600
    fs.utimesSync(lockPath, old, old)

    const outcome = withMigrationLock(dbPath, (o) => o, { timeoutMs: 500, staleMs: 60_000 })

    expect(outcome.stoleStaleLock).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it('does not delete a lock that was stolen from us mid-run', () => {
    const lockPath = `${dbPath}.migrate.lock`
    withMigrationLock(dbPath, () => {
      // Someone decided our lock was stale and took it over.
      fs.writeFileSync(lockPath, 'later.owner')
    })
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe('later.owner')
  })
})

// ---------------------------------------------------------------------------
// Two-process migration
// ---------------------------------------------------------------------------

describe('two-process migration', () => {
  it('does not duplicate DDL or journal rows when two processes migrate at once', async () => {
    // A real second process migrating the same file, taking the same lock.
    const other = runChild(`
      const fs = require('fs');
      const Database = require(${JSON.stringify(path.join(REPO_NODE_MODULES, 'better-sqlite3'))});
      const { drizzle } = require(${JSON.stringify(path.join(REPO_NODE_MODULES, 'drizzle-orm/better-sqlite3'))});
      const { migrate } = require(${JSON.stringify(path.join(REPO_NODE_MODULES, 'drizzle-orm/better-sqlite3/migrator'))});
      const lockPath = ${JSON.stringify(`${dbPath}.migrate.lock`)};
      // Same O_EXCL protocol as withMigrationLock.
      for (;;) {
        try { const fd = fs.openSync(lockPath, 'wx'); fs.writeFileSync(fd, 'child'); fs.closeSync(fd); break; }
        catch (e) { if (e.code !== 'EEXIST') throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
      }
      try {
        const sqlite = new Database(${JSON.stringify(dbPath)});
        sqlite.pragma('busy_timeout = 10000');
        sqlite.pragma('journal_mode = WAL');
        migrate(drizzle(sqlite), { migrationsFolder: ${JSON.stringify(MIGRATIONS_FOLDER)} });
        sqlite.close();
      } finally {
        if (fs.readFileSync(lockPath, 'utf-8') === 'child') fs.rmSync(lockPath, { force: true });
      }
    `)

    const sqlite = new Database(dbPath)
    sqlite.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
    sqlite.pragma('journal_mode = WAL')
    // Whichever process gets there second must not blow up.
    expect(() => runMigrations(sqlite, drizzle(sqlite), dbPath, MIGRATIONS_FOLDER)).not.toThrow()
    await other.done

    const journal = sqlite
      .prepare('SELECT hash, COUNT(*) AS n FROM __drizzle_migrations GROUP BY hash HAVING n > 1')
      .all()
    expect(journal).toEqual([]) // no migration recorded twice
    const columns = sqlite.prepare('PRAGMA table_info(`session`)').all() as { name: string }[]
    expect(columns.filter((c) => c.name === 'creation_method')).toHaveLength(1)
    sqlite.close()
  })
})

// ---------------------------------------------------------------------------
// Partial migration: column present, journal row missing (ELECTRON-KV)
// ---------------------------------------------------------------------------

/**
 * A miniature migrations folder shaped like the real one at the time of
 * ELECTRON-KV: a table, then `ALTER TABLE session ADD creation_method text`
 * (the repo's 0033_normal_whiplash.sql). Synthetic so the test pins the
 * behaviour rather than whichever migration happens to be last today.
 */
function writeSyntheticMigrations(extraColumnMigration = false): string {
  const folder = path.join(tmpDir, 'migrations')
  fs.mkdirSync(path.join(folder, 'meta'), { recursive: true })
  const entries = [
    { tag: '0000_init', sql: 'CREATE TABLE `session` (\n\t`id` text PRIMARY KEY NOT NULL\n);\n', when: 1000 },
    { tag: '0001_creation_method', sql: 'ALTER TABLE `session` ADD `creation_method` text;', when: 2000 },
  ]
  if (extraColumnMigration) {
    entries.push({ tag: '0002_source', sql: 'ALTER TABLE `session` ADD `source` text;', when: 3000 })
  }
  for (const entry of entries) fs.writeFileSync(path.join(folder, `${entry.tag}.sql`), entry.sql)
  fs.writeFileSync(
    path.join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: entries.map((entry, idx) => ({
        idx, version: '6', when: entry.when, tag: entry.tag, breakpoints: true,
      })),
    })
  )
  return folder
}

/** Migrate fully, then roll the journal watermark back to leave schema > journal. */
function makeSchemaAheadOfJournal(folder: string, rollBackTo = 1): InstanceType<typeof Database> {
  const sqlite = new Database(dbPath)
  sqlite.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
  migrate(drizzle(sqlite), { migrationsFolder: folder })
  sqlite
    .prepare('DELETE FROM __drizzle_migrations WHERE created_at > ?')
    .run(rollBackTo * 1000)
  return sqlite
}

describe('partial migration repair', () => {
  it('records the already-applied migration instead of failing on duplicate column', () => {
    const folder = writeSyntheticMigrations()
    const sqlite = makeSchemaAheadOfJournal(folder)
    const before = sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number }

    // Baseline: plain drizzle fails on this database — the KV crash. drizzle
    // wraps the driver error, so the SQLite text is on the cause chain.
    let baselineError: unknown
    try {
      migrate(drizzle(sqlite), { migrationsFolder: folder })
    } catch (error) {
      baselineError = error
    }
    expect(baselineError).toBeInstanceOf(Error)
    expect(isDuplicateColumnError(baselineError)).toBe(true)
    expect(extractDuplicateColumn(baselineError)).toBe('creation_method')

    // Our coordinated path repairs the journal and completes.
    expect(() => runMigrations(sqlite, drizzle(sqlite), dbPath, folder)).not.toThrow()

    const after = sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number }
    expect(after.n).toBe(before.n + 1)
    sqlite.close()
  })

  it('reconciles several already-applied column migrations without looping', () => {
    const folder = writeSyntheticMigrations(true)
    const sqlite = makeSchemaAheadOfJournal(folder) // both column migrations pending again

    expect(() => runMigrations(sqlite, drizzle(sqlite), dbPath, folder)).not.toThrow()

    const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number }
    expect(rows.n).toBe(3)
    sqlite.close()
  })

  it('stays fatal for a replayed non-column migration (never blanket-ignored)', () => {
    const folder = writeSyntheticMigrations()
    // Watermark rolled all the way back: CREATE TABLE replays. That is not a
    // duplicate-column error and must not be swallowed.
    const sqlite = makeSchemaAheadOfJournal(folder, 0)

    expect(() => runMigrations(sqlite, drizzle(sqlite), dbPath, folder)).toThrow(/CREATE TABLE|already exists/i)
    sqlite.close()
  })

  it('stays fatal when the existing column has a different shape', () => {
    const folder = writeSyntheticMigrations()
    const sqlite = makeSchemaAheadOfJournal(folder)
    // Rebuild the column with an incompatible declaration.
    sqlite.exec('ALTER TABLE `session` DROP COLUMN `creation_method`')
    sqlite.exec('ALTER TABLE `session` ADD `creation_method` integer NOT NULL DEFAULT 0')

    let error: unknown
    try {
      runMigrations(sqlite, drizzle(sqlite), dbPath, folder)
    } catch (err) {
      error = err
    }
    expect(isDuplicateColumnError(error)).toBe(true) // stays fatal, unrepaired
    sqlite.close()
  })

  it('declines to repair when the column is genuinely missing', () => {
    const folder = writeSyntheticMigrations()
    const sqlite = makeSchemaAheadOfJournal(folder)
    sqlite.exec('ALTER TABLE `session` DROP COLUMN `creation_method`')

    const outcome = repairJournalForAppliedMigration(sqlite, folder, new Error('duplicate column name: creation_method'))

    expect(outcome).toMatchObject({ repaired: false, reason: 'column-missing' })
    sqlite.close()
  })

  it('never repairs a migration that does more than add columns', () => {
    const statements = ['CREATE TABLE `x` (`id` text)', 'ALTER TABLE `x` ADD `y` text']
    expect(parseAddColumnMigration(statements)).toBeNull()
  })

  it('classifies duplicate-column errors only, through the cause chain', () => {
    expect(isDuplicateColumnError(new Error('duplicate column name: creation_method'))).toBe(true)
    expect(isDuplicateColumnError(new Error('database is locked'))).toBe(false)
    // drizzle's wrapper shape.
    const wrapped = new Error("Failed to run the query 'ALTER TABLE ...'", {
      cause: new Error('duplicate column name: creation_method'),
    })
    expect(isDuplicateColumnError(wrapped)).toBe(true)
    expect(extractDuplicateColumn(wrapped)).toBe('creation_method')
  })

  it('compares the full declared shape, not just the name', () => {
    const [declared] = parseAddColumnMigration(['ALTER TABLE `session` ADD `creation_method` text'])!
    expect(columnMatches(declared, { name: 'creation_method', type: 'text', notnull: 0, dflt_value: null })).toBe(true)
    expect(columnMatches(declared, { name: 'creation_method', type: 'integer', notnull: 0, dflt_value: null })).toBe(false)
    expect(columnMatches(declared, { name: 'creation_method', type: 'text', notnull: 1, dflt_value: null })).toBe(false)
    expect(columnMatches(declared, { name: 'creation_method', type: 'text', notnull: 0, dflt_value: "'x'" })).toBe(false)
    expect(columnMatches(declared, undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unsupported filesystems
// ---------------------------------------------------------------------------

describe('filesystem diagnosis', () => {
  it('recognises UNC network shares', () => {
    expect(classifyDatabaseFilesystem('\\\\nas\\share\\superagent.db')).toBe('network-share')
    expect(classifyDatabaseFilesystem('//nas/share/superagent.db')).toBe('network-share')
    expect(classifyDatabaseFilesystem('/Users/me/.superagent/superagent.db')).toBe('local')
    expect(classifyDatabaseFilesystem('C:\\Users\\me\\superagent.db')).toBe('local')
  })

  it('explains a locking failure on a network share and stays quiet otherwise', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    expect(describeUnsupportedFilesystem('network-share', busy)).toMatch(/network share/i)
    expect(describeUnsupportedFilesystem('local', busy)).toBeNull()
    expect(describeUnsupportedFilesystem('network-share', new Error('syntax error'))).toBeNull()
  })
})

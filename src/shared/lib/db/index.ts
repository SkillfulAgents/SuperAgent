import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import Database from 'better-sqlite3'
import * as schema from './schema'
import fs from 'fs'
import path from 'path'
import { getDatabasePath, getDataDir } from '@shared/lib/config/data-dir'
import { captureException, addErrorBreadcrumb } from '@shared/lib/error-reporting'
import { withMigrationLock, MigrationLockTimeoutError } from './migration-lock'
import { isDuplicateColumnError, repairJournalForAppliedMigration } from './migration-repair'
import {
  classifyDatabaseFilesystem,
  databaseIdentity,
  describeUnsupportedFilesystem,
  sqliteErrorCode,
} from './filesystem-class'

/**
 * How long a writer waits for another connection's write lock before giving
 * up. Without this, better-sqlite3 fails an unlucky concurrent write
 * immediately with SQLITE_BUSY — the app runs several writers (scheduler,
 * renderer requests, container callbacks) plus, briefly, a second process
 * during start/restart overlap.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 10_000

/** Upper bound on journal reconciliations in one startup — never a spin loop. */
const MAX_JOURNAL_REPAIRS = 50

// Run migrations on startup
// This is safe to run on every start - it only applies pending migrations
function getMigrationsFolder(): string {
  // In packaged Electron app, use resources path
  if (process.type === 'browser' && !process.defaultApp) {
    // We're in packaged Electron main process
    return path.join(process.resourcesPath, 'migrations')
  }
  // Development: use source path
  return path.join(process.cwd(), 'src/shared/lib/db/migrations')
}

// Lazy initialization: defer DB creation until first access so that
// SUPERAGENT_DATA_DIR / SUPERAGENT_DB_PATH (set at startup) are available.
let _sqlite: InstanceType<typeof Database> | null = null
let _db: BetterSQLite3Database<typeof schema> | null = null

/**
 * Apply pending migrations under an inter-process lock.
 *
 * Exported for tests. The lock exists because drizzle's migrator reads "last
 * applied migration" outside its transaction: two processes starting together
 * both decide to apply the same files, and the loser either fails with
 * "database is locked" or (once a busy timeout makes it wait) replays applied
 * DDL and fails with "duplicate column name".
 */
export function runMigrations(
  sqlite: InstanceType<typeof Database>,
  db: BetterSQLite3Database<typeof schema>,
  dbPath: string,
  migrationsFolder: string
): void {
  withMigrationLock(dbPath, ({ stoleStaleLock, waitedMs }) => {
    if (stoleStaleLock || waitedMs > 0) {
      addErrorBreadcrumb({
        category: 'database',
        message: 'Acquired migration lock',
        data: { waitedMs, stoleStaleLock, dbId: databaseIdentity(dbPath) },
      })
    }

    // Each pass either applies the pending migrations or reconciles ONE
    // already-applied migration into the journal. Bounded so a repair that
    // stops making progress can never spin.
    for (let repairs = 0; ; repairs++) {
      try {
        migrate(db, { migrationsFolder })
        return
      } catch (error) {
        if (!isDuplicateColumnError(error) || repairs >= MAX_JOURNAL_REPAIRS) throw error

        // The schema may simply be ahead of the journal (a racing starter
        // applied it first). Repair the journal ONLY when every column the
        // migration declares already exists with the exact declared shape.
        const outcome = repairJournalForAppliedMigration(sqlite, migrationsFolder, error)
        if (!outcome.repaired) {
          addErrorBreadcrumb({
            category: 'database',
            message: 'Migration journal repair declined',
            data: { reason: outcome.reason, tag: outcome.tag, dbId: databaseIdentity(dbPath) },
          })
          throw error
        }

        addErrorBreadcrumb({
          category: 'database',
          message: 'Recorded already-applied migration in the journal',
          data: { tag: outcome.tag, columns: outcome.columns.length, dbId: databaseIdentity(dbPath) },
        })
      }
    }
  })
}

function initDb() {
  if (_db) return

  const dbPath = getDatabasePath()
  const dataDir = getDataDir()
  const filesystem = classifyDatabaseFilesystem(dbPath)
  const dbId = databaseIdentity(dbPath)

  // Data dir (settings/agents) and DB parent may differ when SUPERAGENT_DB_PATH is set.
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  const dbParent = path.dirname(dbPath)
  if (!fs.existsSync(dbParent)) {
    fs.mkdirSync(dbParent, { recursive: true })
  }

  try {
    _sqlite = new Database(dbPath)
    // Set the busy timeout FIRST: every statement below (including the WAL
    // switch, which needs an exclusive lock) can contend with another process.
    _sqlite.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
    _sqlite.pragma('journal_mode = WAL')
    _sqlite.pragma('foreign_keys = ON')
  } catch (err) {
    captureException(err, {
      tags: {
        component: 'database',
        operation: 'open',
        filesystem,
        sqliteCode: sqliteErrorCode(err) ?? 'none',
      },
      extra: { dbId },
      level: 'fatal',
    })
    const diagnosis = describeUnsupportedFilesystem(filesystem, err)
    if (diagnosis) throw new Error(diagnosis, { cause: err })
    throw err
  }

  _db = drizzle(_sqlite, { schema })

  try {
    runMigrations(_sqlite, _db, dbPath, getMigrationsFolder())
  } catch (err) {
    captureException(err, {
      tags: {
        component: 'database',
        operation: 'migrate',
        filesystem,
        sqliteCode: sqliteErrorCode(err) ?? 'none',
        phase: err instanceof MigrationLockTimeoutError ? 'lock' : 'apply',
      },
      extra: { dbId },
      level: 'fatal',
    })
    const diagnosis = describeUnsupportedFilesystem(filesystem, err)
    if (diagnosis) throw new Error(diagnosis, { cause: err })
    throw err
  }
}

export const db = new Proxy({} as BetterSQLite3Database<typeof schema>, {
  get(_target, prop, receiver) {
    initDb()
    return Reflect.get(_db!, prop, receiver)
  },
})

// Export for direct SQL access if needed
export const sqlite = new Proxy({} as InstanceType<typeof Database>, {
  get(_target, prop, receiver) {
    initDb()
    return Reflect.get(_sqlite!, prop, receiver)
  },
})

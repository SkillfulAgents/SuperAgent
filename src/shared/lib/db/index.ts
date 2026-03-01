import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import Database from 'better-sqlite3'
import * as schema from './schema'
import fs from 'fs'
import path from 'path'
import { getDatabasePath, getDataDir } from '@shared/lib/config/data-dir'

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
// SUPERAGENT_DATA_DIR (set by the Electron main process at startup)
// is available when the path is resolved.
let _sqlite: InstanceType<typeof Database> | null = null
let _db: BetterSQLite3Database<typeof schema> | null = null

function initDb() {
  if (_db) return

  const dbPath = getDatabasePath()
  const dataDir = getDataDir()

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  _sqlite = new Database(dbPath)
  _sqlite.pragma('journal_mode = WAL')
  _sqlite.pragma('foreign_keys = ON')
  _db = drizzle(_sqlite, { schema })

  migrate(_db, { migrationsFolder: getMigrationsFolder() })
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

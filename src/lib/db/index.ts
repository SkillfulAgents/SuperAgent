import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import Database from 'better-sqlite3'
import * as schema from './schema'
import fs from 'fs'
import path from 'path'
import { getDatabasePath, getDataDir } from '@/lib/config/data-dir'

// Get database path from centralized config
const DB_PATH = getDatabasePath()

// Ensure data directory exists
const dataDir = getDataDir()
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

// Create SQLite database connection
const sqlite = new Database(DB_PATH)

// Enable WAL mode for better concurrent access
sqlite.pragma('journal_mode = WAL')

// Create Drizzle instance
export const db = drizzle(sqlite, { schema })

// Run migrations on startup
// This is safe to run on every start - it only applies pending migrations
const migrationsFolder = path.join(process.cwd(), 'src/lib/db/migrations')
migrate(db, { migrationsFolder })

// Export for direct SQL access if needed
export { sqlite }

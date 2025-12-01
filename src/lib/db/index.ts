import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import * as schema from './schema'
import path from 'path'

// Database file location
const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'superagent.db')

// Create SQLite database connection
const sqlite = new Database(DB_PATH)

// Enable WAL mode for better concurrent access
sqlite.pragma('journal_mode = WAL')

// Create Drizzle instance
export const db = drizzle(sqlite, { schema })

// Export for direct SQL access if needed
export { sqlite }

/**
 * better-sqlite3: the desktop app's and single-tenant web's driver. One
 * native file handle, synchronous statements. This module is the only place
 * that imports the package.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../schema'
import type { DatabaseDriver } from './types'

/**
 * @param location a file path, or `':memory:'` for a private in-memory database
 */
export function betterSqlite3(location: string): DatabaseDriver {
  return {
    name: 'better-sqlite3',
    open() {
      const sqlite = new Database(location)
      sqlite.pragma('journal_mode = WAL')
      sqlite.pragma('foreign_keys = ON')
      return {
        db: drizzle(sqlite, { schema }),
        close: () => {
          sqlite.close()
        },
      }
    },
  }
}

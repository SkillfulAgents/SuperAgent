import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

describe('last_seen_ts migration', () => {
  it('adds a nullable last_seen_ts column to chat_integration_sessions', () => {
    const sqlite = new Database(':memory:')
    migrate(drizzle(sqlite), { migrationsFolder: 'src/shared/lib/db/migrations' })
    const cols = sqlite.prepare(`PRAGMA table_info(chat_integration_sessions)`).all() as Array<{ name: string; notnull: number }>
    const col = cols.find((c) => c.name === 'last_seen_ts')
    expect(col).toBeDefined()
    expect(col!.notnull).toBe(0) // nullable
  })
})

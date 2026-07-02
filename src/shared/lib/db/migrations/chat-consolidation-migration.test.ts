import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import path from 'node:path'
import fs from 'node:fs'

// Exercise the SHIPPED migration set (not a hand-copied DDL) so the test cannot
// pass while the real migration drifts.
describe('chat_integration_sessions consolidation columns', () => {
  let sqlite: Database.Database
  beforeEach(() => {
    sqlite = new Database(':memory:')
    migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  })
  afterEach(() => sqlite.close())

  it('round-trips rotated_at, recap and consolidated_at on a session row', () => {
    const now = Date.now()
    sqlite
      .prepare(`INSERT INTO chat_integrations (id, agent_slug, provider, name, config, status, show_tool_calls, require_approval, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('int-1', 'agent-a', 'telegram', 'TG', '{}', 'active', 0, 1, now, now)
    sqlite
      .prepare(`INSERT INTO chat_integration_sessions (id, integration_id, external_chat_id, session_id, archived_at, rotated_at, recap, consolidated_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('s1', 'int-1', 'chat-1', 'sess-1', now, now, 'a recap', now, now, now)

    const row = sqlite
      .prepare(`SELECT rotated_at, recap, consolidated_at FROM chat_integration_sessions WHERE id = 's1'`)
      .get() as Record<string, unknown>
    expect(row.rotated_at).toBe(now)
    expect(row.recap).toBe('a recap')
    expect(row.consolidated_at).toBe(now)
  })

  it('defaults the three new columns to null on existing-shaped inserts', () => {
    const now = Date.now()
    sqlite
      .prepare(`INSERT INTO chat_integrations (id, agent_slug, provider, name, config, status, show_tool_calls, require_approval, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('int-2', 'agent-a', 'telegram', 'TG', '{}', 'active', 0, 1, now, now)
    sqlite
      .prepare(`INSERT INTO chat_integration_sessions (id, integration_id, external_chat_id, session_id, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run('s2', 'int-2', 'chat-2', 'sess-2', now, now)

    const row = sqlite
      .prepare(`SELECT rotated_at, recap, consolidated_at FROM chat_integration_sessions WHERE id = 's2'`)
      .get() as Record<string, unknown>
    expect(row.rotated_at).toBeNull()
    expect(row.recap).toBeNull()
    expect(row.consolidated_at).toBeNull()
  })

  it('ships 0026 as the newest journal entry (must stay the latest so it runs once on existing DBs)', () => {
    // Drizzle decides which migrations are "pending" by comparing each entry's
    // `when` against the latest recorded created_at — NOT by SQL hash. A new
    // ALTER must therefore be stamped after the previous latest (0025) so it is
    // seen as pending exactly once. If a future migration is stamped earlier
    // than 0026 it would re-run this ALTER and crash on the duplicate column.
    const journal = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'src/shared/lib/db/migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string; when: number }> }
    const entry = journal.entries.find((e) => e.tag === '0026_chunky_moon_knight')
    const prev = journal.entries.find((e) => e.tag === '0025_orange_secret_warriors')
    expect(entry).toBeDefined()
    expect(prev).toBeDefined()
    expect(entry!.when).toBeGreaterThan(prev!.when)
    expect(Math.max(...journal.entries.map((e) => e.when))).toBe(entry!.when)
  })
})

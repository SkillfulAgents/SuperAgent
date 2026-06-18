import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import path from 'node:path'
import { SEED_CHAT_ACCESS_SQL } from '../seed-chat-access-sql'

describe('chat_integration_access seed', () => {
  let sqlite: Database.Database
  beforeEach(() => {
    sqlite = new Database(':memory:')
    migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  })
  afterEach(() => sqlite.close())

  it('seeds allowed access only for active telegram sessions, deduped', () => {
    const now = Date.now()
    const insInt = sqlite.prepare(`INSERT INTO chat_integrations (id, agent_slug, provider, name, config, status, show_tool_calls, require_approval, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    insInt.run('int-tg', 'agent-a', 'telegram', 'TG', '{}', 'active', 0, 1, now, now)
    insInt.run('int-slack', 'agent-a', 'slack', 'SL', '{}', 'active', 0, 1, now, now)
    const insSess = sqlite.prepare(`INSERT INTO chat_integration_sessions (id, integration_id, external_chat_id, session_id, archived_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
    insSess.run('s1', 'int-tg', 'chat-1', 'sess-1', null, now, now)
    insSess.run('s2', 'int-tg', 'chat-1', 'sess-2', null, now, now) // same chat rotated → dedupe
    insSess.run('s3', 'int-tg', 'chat-archived', 'sess-3', now, now, now) // archived → excluded
    insSess.run('s4', 'int-slack', 'chan-1', 'sess-4', null, now, now) // slack → excluded

    sqlite.exec(SEED_CHAT_ACCESS_SQL)

    const rows = sqlite.prepare(`SELECT integration_id, external_chat_id, status, approval_source FROM chat_integration_access`).all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ integration_id: 'int-tg', external_chat_id: 'chat-1', status: 'allowed', approval_source: 'migration' })
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

// Exercise the SHIPPED seed migration file, not a hand-copied duplicate, so the
// test cannot pass while the real migration drifts.
const SEED_SQL = fs.readFileSync(
  path.join(process.cwd(), 'src/shared/lib/db/migrations/0024_seed_chat_access.sql'),
  'utf8',
)

describe('chat_integration_access seed (0024)', () => {
  let sqlite: Database.Database
  beforeEach(() => {
    sqlite = new Database(':memory:')
    migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  })
  afterEach(() => sqlite.close())

  function seedFixtures() {
    const now = Date.now()
    const insInt = sqlite.prepare(`INSERT INTO chat_integrations (id, agent_slug, provider, name, config, status, show_tool_calls, require_approval, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    insInt.run('int-tg', 'agent-a', 'telegram', 'TG', '{}', 'active', 0, 1, now, now)
    insInt.run('int-slack', 'agent-a', 'slack', 'SL', '{}', 'active', 0, 1, now, now)
    const insSess = sqlite.prepare(`INSERT INTO chat_integration_sessions (id, integration_id, external_chat_id, session_id, archived_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
    insSess.run('s1', 'int-tg', 'chat-1', 'sess-1', null, now, now)
    insSess.run('s2', 'int-tg', 'chat-1', 'sess-2', null, now, now) // same chat rotated → dedupe
    insSess.run('s3', 'int-tg', 'chat-archived', 'sess-3', now, now, now) // archived → excluded
    insSess.run('s4', 'int-slack', 'chan-1', 'sess-4', null, now, now) // slack → excluded
  }

  it('seeds allowed access only for active telegram sessions, deduped', () => {
    seedFixtures()
    sqlite.exec(SEED_SQL)
    const rows = sqlite.prepare(`SELECT integration_id, external_chat_id, status, approval_source FROM chat_integration_access`).all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ integration_id: 'int-tg', external_chat_id: 'chat-1', status: 'allowed', approval_source: 'migration' })
  })

  it('0024 journal timestamp must stay immutable — raising it re-runs the seed on existing DBs', () => {
    // Drizzle decides which migrations are "pending" by comparing each entry's
    // `when` against the latest recorded created_at — NOT by SQL hash. 0024 was
    // applied at 1781000000000 (below 0023's), so on an existing DB it is never
    // pending. Raising it above 0023's would make 0024 look pending and re-run the
    // non-idempotent seed, crashing startup on the unique index. This value is
    // shipped/applied metadata and must not change.
    const journal = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'src/shared/lib/db/migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string; when: number }> }
    const seed = journal.entries.find((e) => e.tag === '0024_seed_chat_access')
    const ddl = journal.entries.find((e) => e.tag === '0023_bent_justin_hammer')
    expect(seed?.when).toBe(1781000000000)
    expect(seed!.when).toBeLessThan(ddl!.when)
  })
})

describe('chat_integration_access DDL constraints (0023)', () => {
  let sqlite: Database.Database
  beforeEach(() => {
    sqlite = new Database(':memory:')
    migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    const now = Date.now()
    sqlite.prepare(`INSERT INTO chat_integrations (id, agent_slug, provider, config, created_at, updated_at) VALUES ('int-1','a','telegram','{}',?,?)`).run(now, now)
  })
  afterEach(() => sqlite.close())

  function insertAccess(opts: { status?: string; chatType?: string | null; source?: string | null; chat?: string }) {
    const now = Date.now()
    sqlite
      .prepare(`INSERT INTO chat_integration_access (id, integration_id, external_chat_id, chat_type, status, approval_source, requested_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), 'int-1', opts.chat ?? `chat-${crypto.randomUUID()}`, opts.chatType ?? null, opts.status ?? 'pending', opts.source ?? null, now, now, now)
  }

  it('rejects an invalid status', () => {
    expect(() => insertAccess({ status: 'bogus' })).toThrow()
  })
  it('rejects an invalid chat_type', () => {
    expect(() => insertAccess({ chatType: 'channel' })).toThrow()
  })
  it('rejects an invalid approval_source', () => {
    expect(() => insertAccess({ source: 'hacker' })).toThrow()
  })
  it('accepts valid enums including null chat_type / approval_source', () => {
    expect(() => insertAccess({ status: 'allowed', chatType: 'group', source: 'owner' })).not.toThrow()
    expect(() => insertAccess({ status: 'pending', chatType: null, source: null })).not.toThrow()
  })
  it('rejects a duplicate (integration_id, external_chat_id) pair', () => {
    insertAccess({ chat: 'dup-chat' })
    expect(() => insertAccess({ chat: 'dup-chat' })).toThrow()
  })
})

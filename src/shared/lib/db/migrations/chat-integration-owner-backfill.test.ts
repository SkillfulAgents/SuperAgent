import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import path from 'node:path'
import fs from 'node:fs'

// Exercise the SHIPPED backfill migration file, not a hand-copied duplicate, so
// the test cannot pass while the real migration drifts.
const BACKFILL_SQL = fs.readFileSync(
  path.join(process.cwd(), 'src/shared/lib/db/migrations/0026_backfill_chat_integration_owners.sql'),
  'utf8',
)

describe('chat_integrations owner backfill (0026)', () => {
  let sqlite: Database.Database
  beforeEach(() => {
    sqlite = new Database(':memory:')
    migrate(drizzle(sqlite), { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
  })
  afterEach(() => sqlite.close())

  function addIntegration(id: string, owner: string | null) {
    const now = Date.now()
    sqlite
      .prepare(
        `INSERT INTO chat_integrations (id, agent_slug, provider, config, status, show_tool_calls, require_approval, created_by_user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, 'agent-a', 'telegram', '{}', 'active', 0, 1, owner, now, now)
  }

  function addUser(id: string) {
    sqlite.prepare(`INSERT INTO user (id, name, email) VALUES (?,?,?)`).run(id, 'U', `${id}@example.com`)
  }

  function ownerOf(id: string): string | null {
    return (sqlite.prepare(`SELECT created_by_user_id AS o FROM chat_integrations WHERE id = ?`).get(id) as { o: string | null }).o
  }

  it("backfills null/empty owners to 'local' in single-user mode (no user rows)", () => {
    addIntegration('int-null', null)
    addIntegration('int-empty', '')
    addIntegration('int-owned', 'someone')

    sqlite.exec(BACKFILL_SQL)

    expect(ownerOf('int-null')).toBe('local')
    expect(ownerOf('int-empty')).toBe('local')
    expect(ownerOf('int-owned')).toBe('someone') // already owned → untouched
  })

  it('is a no-op on a multi-user deployment (user rows present)', () => {
    addUser('u1')
    addIntegration('int-null', null)

    sqlite.exec(BACKFILL_SQL)

    // Cannot fabricate an owner on multi-user; legacy null owner stays null.
    expect(ownerOf('int-null')).toBeNull()
  })

  it('0026 journal timestamp must stay above 0025 so it runs as pending on existing DBs', () => {
    // Unlike the 0024 seed (deliberately back-dated so it never re-runs), this
    // backfill is idempotent and MUST be pending on DBs already at the prior
    // migration — so its `when` must exceed the highest previously-applied entry
    // (0025_orange_secret_warriors). This value is shipped/applied metadata; keep it pinned.
    const journal = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'src/shared/lib/db/migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string; when: number }> }
    const backfill = journal.entries.find((e) => e.tag === '0026_backfill_chat_integration_owners')
    const prior = journal.entries.find((e) => e.tag === '0025_orange_secret_warriors')
    expect(backfill?.when).toBe(1782496663786)
    expect(backfill!.when).toBeGreaterThan(prior!.when)
  })
})

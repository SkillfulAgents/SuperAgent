import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MIGRATIONS = path.join(process.cwd(), 'src/shared/lib/db/migrations')
const TAG = '0049_message_author_integrations'

// Exercise the SHIPPED migration file against a database migrated to just
// before it, so the test cannot pass while the real migration drifts.
const MIGRATION_SQL = fs.readFileSync(path.join(MIGRATIONS, `${TAG}.sql`), 'utf8')

/** A copy of the migrations folder whose journal stops before `tag`. */
function folderBefore(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-before-'))
  fs.mkdirSync(path.join(dir, 'meta'))
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>
  }
  const cut = journal.entries.findIndex((entry) => entry.tag === tag)
  expect(cut).toBeGreaterThan(0)
  const entries = journal.entries.slice(0, cut)
  for (const entry of entries) fs.copyFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`))
  fs.writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  return dir
}

describe(TAG, () => {
  let sqlite: Database.Database
  let folder: string

  beforeEach(() => {
    folder = folderBefore(TAG)
    sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    migrate(drizzle(sqlite), { migrationsFolder: folder })
    sqlite.prepare(`INSERT INTO user (id, name, email) VALUES ('user-1', 'Grace', 'grace@example.com')`).run()
    sqlite.prepare(`INSERT INTO message_author (id, session_id, agent_slug, user_id, created_at) VALUES ('m1', 's1', 'agent', 'user-1', 1790000000000)`).run()
  })

  afterEach(() => {
    sqlite.close()
    fs.rmSync(folder, { recursive: true, force: true })
  })

  it('keeps every existing user row, and still cascades when the user is deleted', () => {
    sqlite.exec(MIGRATION_SQL)

    expect(sqlite.prepare(`SELECT id, session_id, agent_slug, user_id, integration_id, display, created_at FROM message_author`).all()).toEqual([
      { id: 'm1', session_id: 's1', agent_slug: 'agent', user_id: 'user-1', integration_id: null, display: null, created_at: 1790000000000 },
    ])
    sqlite.prepare(`DELETE FROM user WHERE id = 'user-1'`).run()
    expect(sqlite.prepare(`SELECT count(*) AS n FROM message_author`).get()).toEqual({ n: 0 })
  })

  it('accepts an integration author with its card, and nothing half-authored', () => {
    sqlite.exec(MIGRATION_SQL)
    const insert = sqlite.prepare(`INSERT INTO message_author (id, session_id, agent_slug, user_id, integration_id, display) VALUES (?, 's1', 'agent', ?, ?, ?)`)

    insert.run('m2', null, 'integration-1', '{"version":1}')
    expect(() => insert.run('m3', null, null, null)).toThrow(/CHECK/)
    expect(() => insert.run('m4', null, 'integration-1', null)).toThrow(/CHECK/)
    expect(() => insert.run('m5', 'user-1', 'integration-1', '{}')).toThrow(/CHECK/)
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'message_author'`).all())
      .toContainEqual({ name: 'message_author_session_idx' })
  })
})

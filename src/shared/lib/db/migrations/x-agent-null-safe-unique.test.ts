import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MIGRATIONS = path.join(process.cwd(), 'src/shared/lib/db/migrations')
const TAG = '0044_x_agent_policies_null_safe_unique'

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

describe(`${TAG}`, () => {
  let sqlite: Database.Database
  let folder: string

  beforeEach(() => {
    folder = folderBefore(TAG)
    sqlite = new Database(':memory:')
    migrate(drizzle(sqlite), { migrationsFolder: folder })
  })

  afterEach(() => {
    sqlite.close()
    fs.rmSync(folder, { recursive: true, force: true })
  })

  function insertPolicy(id: string, caller: string, target: string | null, operation: string, decision: string, updatedAt: number) {
    sqlite
      .prepare(`INSERT INTO x_agent_policies (id, caller_agent_slug, target_agent_slug, operation, decision, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, caller, target, operation, decision, updatedAt, updatedAt)
  }

  function policies() {
    return sqlite
      .prepare(`SELECT id, caller_agent_slug AS caller, target_agent_slug AS target, operation, decision FROM x_agent_policies ORDER BY id`)
      .all() as Array<{ id: string; caller: string; target: string | null; operation: string; decision: string }>
  }

  it('keeps the most recently updated global row per (caller, operation) and leaves the rest alone', () => {
    // Before the null-safe index, NULL targets were distinct in the unique
    // index, so concurrent writes could leave several global rows.
    insertPolicy('old-list', 'alice', null, 'list', 'allow', 1000)
    insertPolicy('new-list', 'alice', null, 'list', 'block', 2000)
    insertPolicy('mid-list', 'alice', null, 'list', 'review', 1500)
    insertPolicy('bob-list', 'bob', null, 'list', 'allow', 1000)
    insertPolicy('alice-read', 'alice', null, 'read', 'allow', 1000)
    insertPolicy('specific', 'alice', 'carol', 'list', 'allow', 1000)

    sqlite.exec(MIGRATION_SQL)

    expect(policies().map((row) => row.id)).toEqual(['alice-read', 'bob-list', 'new-list', 'specific'])
    expect(policies().find((row) => row.id === 'new-list')?.decision).toBe('block')
  })

  it('then rejects a second global row for the same (caller, operation)', () => {
    sqlite.exec(MIGRATION_SQL)
    insertPolicy('first', 'alice', null, 'list', 'allow', 1000)
    expect(() => insertPolicy('second', 'alice', null, 'list', 'block', 2000)).toThrow(/UNIQUE/)
    // Specific targets are still distinct from the global row and from each other.
    insertPolicy('carol', 'alice', 'carol', 'list', 'allow', 1000)
    insertPolicy('dave', 'alice', 'dave', 'list', 'allow', 1000)
    expect(policies()).toHaveLength(3)
  })

  it('is the last step in the journal, so the folder migrator applies it', () => {
    const fresh = new Database(':memory:')
    migrate(drizzle(fresh), { migrationsFolder: MIGRATIONS })
    const indexes = fresh.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'x_agent_policies'`).all() as Array<{ name: string }>
    expect(indexes.map((row) => row.name)).toContain('x_agent_policies_null_safe_unique')
    fresh.close()
  })
})

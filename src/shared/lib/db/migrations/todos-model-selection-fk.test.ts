import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MIGRATIONS = path.join(process.cwd(), 'src/shared/lib/db/migrations')
const TAG = '0053_todos_model_selection_fk'

/** A copy of the migrations folder whose journal ends with `last`. */
function folderThrough(last: string, inclusive: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-through-'))
  fs.mkdirSync(path.join(dir, 'meta'))
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>
  }
  const at = journal.entries.findIndex((entry) => entry.tag === last)
  expect(at).toBeGreaterThan(0)
  const entries = journal.entries.slice(0, inclusive ? at + 1 : at)
  for (const entry of entries) fs.copyFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`))
  fs.writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  return dir
}

describe(TAG, () => {
  let sqlite: Database.Database
  const folders: string[] = []

  const migrateTo = (inclusive: boolean) => {
    const folder = folderThrough(TAG, inclusive)
    folders.push(folder)
    migrate(drizzle(sqlite), { migrationsFolder: folder })
  }

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    migrateTo(false)
    const now = Date.now()
    sqlite.prepare(`INSERT INTO llm_connections (id, name, provider, config, created_at, updated_at) VALUES ('conn-1', 'Work', 'anthropic', '{}', ?, ?)`).run(now, now)
    const insertTodo = sqlite.prepare(`INSERT INTO todos (id, user_id, title, agent_slug, llm_provider_id, model, effort, speed, session_id, status, position, created_at, updated_at)
      VALUES (?, 'alice', ?, 'agent-a', ?, 'claude-opus-5-5', 'high', 'fast', ?, ?, 1, ?, ?)`)
    insertTodo.run('kept', 'Kept', 'conn-1', null, 'draft', now, now)
    insertTodo.run('dangling', 'Dangling', 'conn-gone', 'session-1', 'active', now, now)
  })

  afterEach(() => {
    sqlite.close()
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true })
  })

  const todo = (id: string) => sqlite.prepare(`SELECT * FROM todos WHERE id = ?`).get(id) as Record<string, unknown>

  it('keeps every todo and its pick, and drops a pick of a connection that no longer exists', () => {
    migrateTo(true)
    expect(todo('kept')).toMatchObject({ title: 'Kept', llm_provider_id: 'conn-1', model: 'claude-opus-5-5', effort: 'high', speed: 'fast' })
    expect(todo('dangling')).toMatchObject({ title: 'Dangling', llm_provider_id: null, model: 'claude-opus-5-5', session_id: 'session-1' })
    expect(sqlite.prepare('PRAGMA foreign_key_check(todos)').all()).toEqual([])
  })

  it('then drops a pick when its connection is deleted, like the other tables', () => {
    migrateTo(true)
    sqlite.prepare(`DELETE FROM llm_connections WHERE id = 'conn-1'`).run()
    expect(todo('kept')).toMatchObject({ llm_provider_id: null, model: 'claude-opus-5-5' })
  })

  it('still refuses a draft that has a session', () => {
    migrateTo(true)
    expect(() => sqlite.prepare(`UPDATE todos SET session_id = 'session-9' WHERE id = 'kept'`).run()).toThrow(/CHECK constraint failed/)
  })

  it('keeps the board indexes', () => {
    migrateTo(true)
    const indexes = (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todos'`).all() as { name: string }[]).map((r) => r.name)
    expect(indexes).toEqual(expect.arrayContaining(['todos_user_idx', 'todos_agent_session_idx']))
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

// Apply the shipped SQL files in journal order up to a given index, exactly as
// drizzle's migrator does (split on the statement breakpoint).
const MIGRATIONS_DIR = path.join(process.cwd(), 'src/shared/lib/db/migrations')
const journal = JSON.parse(
  fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; tag: string }> }

function applyUpTo(sqlite: Database.Database, maxIdx: number) {
  for (const entry of journal.entries) {
    if (entry.idx > maxIdx) continue
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement)
    }
  }
}

function applyOnly(sqlite: Database.Database, idx: number) {
  const entry = journal.entries.find((e) => e.idx === idx)
  if (!entry) throw new Error(`no migration with idx ${idx}`)
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement)
  }
}

describe('0037 event wakes: scheduled_tasks rebuild keeps live rows and the pending-wake index', () => {
  let sqlite: Database.Database
  beforeEach(() => {
    sqlite = new Database(':memory:')
    applyUpTo(sqlite, 36)
  })
  afterEach(() => sqlite.close())

  function seed() {
    const now = Date.now()
    const ins = sqlite.prepare(
      `INSERT INTO scheduled_tasks (id, agent_slug, schedule_type, schedule_expression, prompt, status, next_execution_at, is_recurring, execution_count, created_at, resume_session_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    ins.run('w-pending', 'a', 'at', 'at tomorrow 9am', 'note', 'pending', now + 3600_000, 0, 0, now, 'sess-1')
    ins.run('w-executed', 'a', 'at', 'at yesterday', 'note', 'executed', now - 3600_000, 0, 1, now, 'sess-2')
    ins.run('w-cancelled', 'a', 'at', 'at yesterday', 'note', 'cancelled', now - 3600_000, 0, 0, now, 'sess-1')
    ins.run('t-cron', 'a', 'cron', '0 9 * * *', 'daily', 'pending', now + 60_000, 1, 3, now, null)
  }

  it('keeps every row and adds the new column as null', () => {
    seed()
    applyOnly(sqlite, 37)
    const rows = sqlite
      .prepare(`SELECT id, status, next_execution_at, wake_on_sessions FROM scheduled_tasks ORDER BY id`)
      .all() as Array<Record<string, unknown>>
    expect(rows.map((r) => r.id)).toEqual(['t-cron', 'w-cancelled', 'w-executed', 'w-pending'])
    expect(rows.every((r) => r.wake_on_sessions === null)).toBe(true)
    expect(rows.find((r) => r.id === 'w-pending')!.next_execution_at).toBeTypeOf('number')
  })

  it('still enforces one pending wake per session after the rebuild', () => {
    seed()
    applyOnly(sqlite, 37)
    const indexes = sqlite.prepare(`PRAGMA index_list('scheduled_tasks')`).all() as Array<{ name: string; unique: number; partial: number }>
    const idx = indexes.find((i) => i.name === 'scheduled_tasks_pending_wake_unique')
    expect(idx).toBeDefined()
    expect(idx!.unique).toBe(1)
    expect(idx!.partial).toBe(1)
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO scheduled_tasks (id, agent_slug, schedule_type, schedule_expression, prompt, status, next_execution_at, is_recurring, execution_count, created_at, resume_session_id)
           VALUES ('dup','a','at','at tomorrow','n','pending',?,0,0,?, 'sess-1')`,
        )
        .run(Date.now() + 1000, Date.now()),
    ).toThrow(/UNIQUE/)
  })

  it('accepts an event row with no time', () => {
    applyOnly(sqlite, 37)
    sqlite
      .prepare(
        `INSERT INTO scheduled_tasks (id, agent_slug, schedule_type, schedule_expression, prompt, status, next_execution_at, is_recurring, execution_count, created_at, resume_session_id, wake_on_sessions)
         VALUES ('e1','a','event','','','pending',NULL,0,0,?, 'sess-9', '{"targets":[]}')`,
      )
      .run(Date.now())
    const row = sqlite.prepare(`SELECT schedule_type, next_execution_at FROM scheduled_tasks WHERE id = 'e1'`).get() as Record<string, unknown>
    expect(row).toEqual({ schedule_type: 'event', next_execution_at: null })
  })
})

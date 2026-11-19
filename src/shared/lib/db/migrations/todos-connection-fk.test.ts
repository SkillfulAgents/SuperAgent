import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { migrateFromBundle } from '../open-database'
import type { AppDatabase } from '../drivers/types'
import { migrationBundle } from './bundle'

// 0070 rebuilds todos with the reference to llm_connections that the other
// tables keeping a model pick (scheduled_tasks, webhook_triggers,
// chat_integrations) have always had.

let handle: TestDatabase | undefined
afterEach(async () => { await handle?.close() })

const fkMigration = migrationBundle.findIndex(m => m.sql.some(s => s.includes('__new_todos')))

async function seedConnection(db: AppDatabase, id: string) {
  await db.run(sql`INSERT INTO llm_connections (id, name, provider, config, created_at, updated_at) VALUES (${id}, ${id}, 'anthropic', '{}', 1, 1)`)
}

/** A todo with every column set, so the rebuild is seen to carry each one over. */
async function seedTodo(db: AppDatabase, id: string, llmProviderId: string | null, started: boolean) {
  await db.run(sql`INSERT INTO todos (id, user_id, title, description, agent_slug, new_agent, model, llm_provider_id, effort, speed,
      session_id, status, position, start_claim, start_claimed_at, created_at, updated_at, started_at, completed_at, attachments)
    VALUES (${id}, 'alice', ${`Title ${id}`}, 'Brief', 'agent-a', 0, 'claude-opus-5-5', ${llmProviderId}, 'high', 'fast',
      ${started ? 'session-1' : null}, ${started ? 'active' : 'draft'}, 7.5, ${started ? null : 'claim-1'}, ${started ? null : 3}, 1, 2, ${started ? 4 : null}, null,
      '[{"kind":"file","path":"uploads/brief.pdf","name":"brief.pdf"}]')`)
}

async function todo(db: AppDatabase, id: string): Promise<Record<string, unknown>> {
  const [row] = await db.all<Record<string, unknown>>(sql`SELECT * FROM todos WHERE id = ${id}`)
  return row
}

/** The SQLite error behind drizzle's "Failed to run the query" wrapper. */
async function sqliteError(work: Promise<unknown>): Promise<string> {
  const error = await work.then(() => undefined, (rejection: unknown) => rejection)
  expect(error).toBeInstanceOf(Error)
  return String((error as Error).cause ?? error)
}

describe('0070 todos connection FK', () => {
  // Off is how `drizzle-kit migrate` runs it: libsql's migrate() turns foreign keys off.
  it.each(['ON', 'OFF'] as const)('keeps every todo whole, and drops only a pick of a connection that is already gone (foreign keys %s)', async (foreignKeys) => {
    expect(fkMigration).toBeGreaterThan(0)
    handle = await createTestDatabase({ migrations: migrationBundle.slice(0, fkMigration) })
    const db = handle.db
    await seedConnection(db, 'conn-1')
    await seedTodo(db, 'kept', 'conn-1', false)
    await seedTodo(db, 'dangling', 'conn-gone', true)
    await seedTodo(db, 'unpicked', null, false)
    const before = { kept: await todo(db, 'kept'), dangling: await todo(db, 'dangling'), unpicked: await todo(db, 'unpicked') }

    await db.run(sql.raw(`PRAGMA foreign_keys = ${foreignKeys}`))
    await migrateFromBundle(db)
    await db.run(sql`PRAGMA foreign_keys = ON`)

    expect(await todo(db, 'kept')).toEqual(before.kept)
    expect(await todo(db, 'unpicked')).toEqual(before.unpicked)
    // The model, effort and speed stay; without a connection the start falls back to the agent's default.
    expect(await todo(db, 'dangling')).toEqual({ ...before.dangling, llm_provider_id: null })
    expect(await db.all(sql`SELECT name FROM sqlite_master WHERE instr(name, '__new_') = 1`)).toEqual([])
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([])

    // The rebuilt table follows a deleted connection, as the other tables do.
    await db.run(sql`DELETE FROM llm_connections WHERE id = 'conn-1'`)
    expect(await todo(db, 'kept')).toEqual({ ...before.kept, llm_provider_id: null })
  })

  it('declares the reference on a fresh database, with the table\'s check and indexes intact', async () => {
    handle = await createTestDatabase()
    const db = handle.db
    const fks = await db.all<{ table: string; from: string; on_delete: string }>(sql`SELECT * FROM pragma_foreign_key_list('todos')`)
    expect(fks.map(fk => [fk.from, fk.table, fk.on_delete])).toEqual([['llm_provider_id', 'llm_connections', 'SET NULL']])
    expect(await sqliteError(seedTodo(db, 'nowhere', 'no-such-connection', false))).toMatch(/FOREIGN KEY constraint failed/)

    await seedTodo(db, 'draft', null, false)
    const giveSession = async () => { await db.run(sql`UPDATE todos SET session_id = 'session-9' WHERE id = 'draft'`) }
    expect(await sqliteError(giveSession())).toMatch(/CHECK constraint failed/)
    const indexes = await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todos' AND name LIKE 'todos_%' ORDER BY name`)
    expect(indexes.map(index => index.name)).toEqual(['todos_agent_session_idx', 'todos_user_idx'])
  })
})

import { afterEach, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { migrateFromBundle } from '../open-database'
import { messageAuthor, user } from '../schema'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { migrationBundle } from './bundle'

let handle: TestDatabase
afterEach(async () => { await handle?.close() })

// The original PR build used 0070 for the caller slug and kept its payer in user_id.
const previewMigration = {
  sql: ['ALTER TABLE `message_author` ADD `author_agent_slug` text;'],
  bps: true, folderMillis: 1794962128928, hash: 'c512a8a3b70802c6730ab015bf7d8de3d24d96a53a66eb79e22fd306a7a0ccd0',
}

it.each(['main', 'previous PR build'])('upgrades %s and preserves the existing author rows', async (from) => {
  const index = migrationBundle.findIndex(m => m.sql.some(statement => statement.includes('CREATE TABLE `__new_message_author`')))
  expect(index).toBeGreaterThan(72)
  const previous = from === 'main' ? migrationBundle.slice(0, index) : [...migrationBundle.slice(0, 70), previewMigration]
  handle = await createTestDatabase({ migrations: previous })
  const db = handle.db
  await db.insert(user).values({ id: 'payer', name: 'Payer', email: 'payer@example.test' }).run()
  await db.run(sql`INSERT INTO message_author (id, session_id, agent_slug, user_id, created_at)
                   VALUES ('human', 'session', 'recipient', 'payer', 100)`)
  await db.run(sql`INSERT INTO message_author (id, session_id, agent_slug, integration_id, display, created_at)
                   VALUES ('card', 'session', 'recipient', 'integration', '{}', 200)`)
  if (from === 'previous PR build') {
    await db.run(sql`INSERT INTO message_author (id, session_id, agent_slug, user_id, author_agent_slug, created_at)
                     VALUES ('agent', 'session', 'recipient', 'payer', 'writer', 300)`)
  }

  await migrateFromBundle(db)
  const read = async (id: string) => db.select().from(messageAuthor).where(eq(messageAuthor.id, id)).get()
  expect(await read('human')).toMatchObject({ userId: 'payer', billedUserId: null, authorAgentSlug: null, createdAt: new Date(100) })
  expect(await read('card')).toMatchObject({ integrationId: 'integration', display: '{}', createdAt: new Date(200) })
  if (from === 'previous PR build') {
    expect(await read('agent')).toMatchObject({ userId: null, billedUserId: 'payer', authorAgentSlug: 'writer', createdAt: new Date(300) })
  } else {
    await db.insert(messageAuthor).values({ id: 'agent', sessionId: 'session', agentSlug: 'recipient', authorAgentSlug: 'writer', billedUserId: 'payer' }).run()
  }
  await db.delete(user).where(eq(user.id, 'payer')).run()
  expect(await read('human')).toBeUndefined()
  expect(await read('agent')).toMatchObject({ userId: null, billedUserId: null, authorAgentSlug: 'writer' })
  expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
})
